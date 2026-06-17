#!/usr/bin/env node
/**
 * Find installable versions of a package from a (custom) Debian apt repository.
 *
 * Discovers every version a repository advertises for a package via
 * `apt-cache madison`, then attempts to download each one into an isolated apt
 * cache directory (`apt-get install --download-only`), recording success/failure
 * per version to a JSON report.
 *
 * Example:
 *     node main.mjs bash \
 *         --repository http://deb.debian.org/debian
 *
 *     # only probe the newest 5 versions, stop at the first that downloads
 *     node main.mjs bash --repository http://deb.debian.org/debian \
 *         --limit 5 --first-only
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// apt version the test environment is pinned to by default. Install-tests run
// against this apt, so it governs resolver/cache behaviour. Override via
// --apt-version (CLI) or the `apt` command (REPL). apt has no in-place
// "pin yourself to version X" command, so this constant is advisory: we record
// it, surface it, and warn if the host apt differs.
export const DEFAULT_APT_VERSION = "2.6.1";

// Environment knobs read via process.env, each falling back to the value the
// Debian / apt ecosystem uses by default ("industry standard"). apt itself reads
// some of these from the environment; we resolve them explicitly so the
// documented default still applies when the var is unset, and so they can be
// surfaced (REPL `env`) and threaded into every apt invocation we build.
export const ENV_DEFAULTS = {
  APT_VERBOSE: "0",                                // apt: quiet (0 = no -o Debug)
  APT_CERT: "",                                    // apt: use system CA store
  APT_INDEX: "http://deb.debian.org/debian",       // apt: mirror base
  APT_REPOSITORY: "http://deb.debian.org/debian",  // apt: repo URL (sources.list)
  APT_TRUSTED_HOST: "",                            // apt: no extra trusted hosts
  APT_DEFAULT_TIMEOUT: "15",                       // apt: Acquire timeout (s)
  APT_RETRIES: "5",                               // apt: Acquire retries
  DEBIAN_REGISTRY_URL: "http://deb.debian.org/debian",  // our repo fallback
  DEBIAN_REGISTRY_NAME: "Debian",                 // registry display name
  REQUESTS_CA_BUNDLE: "",                          // requests/urllib3: certifi
  SSL_CERT_FILE: "",                              // OpenSSL: system CA file
  SSL_CERT_DIR: "",                              // OpenSSL: system CA dir
};

// TLS vars passed through to child processes via the environment (no CLI flag).
const TLS_ENV_VARS = ["REQUESTS_CA_BUNDLE", "SSL_CERT_FILE", "SSL_CERT_DIR"];

/**
 * Resolve every supported env var, falling back to its industry default.
 *
 * `overrides` (non-null/undefined values only) win over both env and defaults —
 * used to fold in command-line flags. Returns a fresh object each call.
 */
export function resolveEnv(overrides = null) {
  const cfg = {};
  for (const [name, def] of Object.entries(ENV_DEFAULTS)) {
    cfg[name] = process.env[name] ?? def;
  }
  if (overrides) {
    for (const [k, v] of Object.entries(overrides)) {
      if (v !== null && v !== undefined) cfg[k] = v;
    }
  }
  return cfg;
}

/** Pick the repo URL: explicit flag > APT_REPOSITORY > DEBIAN_REGISTRY_URL. */
export function resolveIndexUrl(explicit, cfg = null) {
  cfg = cfg || resolveEnv();
  return explicit || cfg.APT_REPOSITORY || cfg.DEBIAN_REGISTRY_URL || null;
}

/** Translate resolved config into apt command-line flags. */
export function aptOptions(cfg) {
  const opts = [];
  let level;
  try {
    level = parseInt(cfg.APT_VERBOSE, 10);
    if (Number.isNaN(level)) level = 0;
  } catch {
    level = 0;
  }
  if (level > 0) opts.push("-o", "Debug::pkgAcquire=true"); // apt's closest thing to -v
  // apt reads timeouts/retries via -o Acquire::* options; mirror the reference
  // config surface even where defaults already apply.
  opts.push("-o", `Acquire::http::Timeout=${cfg.APT_DEFAULT_TIMEOUT}`);
  opts.push("-o", `Acquire::Retries=${cfg.APT_RETRIES}`);
  return opts;
}

/** Child-process environment with resolved TLS cert vars applied. */
export function subprocessEnv(cfg) {
  const env = { ...process.env };
  for (const name of TLS_ENV_VARS) {
    if (cfg[name]) env[name] = cfg[name];
  }
  if (cfg.APT_CERT) env.APT_CERT = cfg.APT_CERT;
  // apt-get is interactive-averse; force non-interactive in every child.
  if (!("DEBIAN_FRONTEND" in env)) env.DEBIAN_FRONTEND = "noninteractive";
  return env;
}

/**
 * Return the list of versions a repository advertises for `package`.
 *
 * Versions are returned in the order `apt-cache madison` emits them (which is
 * highest/preferred-first per apt's own ordering). Each madison row is
 * `name | version | repo`, pipe-separated; we take column 2. When `verbose` is
 * set, the apt command and its raw output are echoed so a failed or empty
 * discovery can be debugged.
 */
export function getAvailableVersions(pkg, indexUrl, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  console.log(`Retrieving versions for '${pkg}' from ${indexUrl}...`);
  const cmd = ["madison", pkg, ...aptOptions(cfg)];
  if (verbose) console.log(`  $ apt-cache ${cmd.join(" ")}`);

  const res = spawnSync("apt-cache", cmd, { encoding: "utf8", env: subprocessEnv(cfg) });
  if (res.error && res.error.code === "ENOENT") {
    console.error("Error: 'apt-cache' not found on PATH (run inside Debian/Ubuntu).");
    process.exit(1);
  }
  if (res.status !== 0) {
    if (verbose) echo(res.stdout, res.stderr);
    console.error(`Error running 'apt-cache madison': ${(res.stderr || "").trim()}`);
    process.exit(1);
  }

  if (verbose) echo(res.stdout);
  // madison rows look like:
  //   bash | 5.2.15-2+b2 | http://deb.debian.org/debian bookworm/main amd64 Packages
  // The version is the second pipe-separated column. Preserve madison's order.
  const versions = [];
  for (const line of (res.stdout || "").split(/\r?\n/)) {
    const parts = line.split("|").map((p) => p.trim());
    if (parts.length >= 2 && parts[1]) {
      if (!versions.includes(parts[1])) versions.push(parts[1]);
    }
  }
  if (!versions.length) {
    console.error("Could not find any versions in apt-cache madison output.");
    return [];
  }
  return versions;
}

/**
 * Create a fresh isolated apt cache dir if needed; return its path.
 *
 * The "isolated test env" for apt is a throwaway cache directory targeted via
 * `-o Dir::Cache=<dir>` — the analog of pip's venv. Download-tests write
 * archives there so the host system stays untouched. `aptVersion` is advisory
 * (apt cannot re-pin itself in place): when set we verify the host apt matches
 * and `verbose` echoes the check. Pass `aptVersion=null` to skip the check
 * entirely.
 */
export function setupVenv(envDir, aptVersion = DEFAULT_APT_VERSION, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  if (!fs.existsSync(envDir)) {
    console.log(`Creating isolated apt cache dir at: ${envDir}`);
    fs.mkdirSync(path.join(envDir, "archives", "partial"), { recursive: true });
  }

  // The "handle" the test step needs is the cache directory itself.
  const cachePath = envDir;

  if (aptVersion) ensureAptVersion(aptVersion, cfg, verbose);
  return cachePath;
}

/** Verify the host apt matches `aptVersion` (advisory only). */
function ensureAptVersion(aptVersion, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  console.log(`Ensuring apt==${aptVersion} in the test environment...`);
  const cmd = ["--version"];
  if (verbose) console.log(`  $ apt-get ${cmd.join(" ")}`);
  const res = spawnSync("apt-get", cmd, { encoding: "utf8", env: subprocessEnv(cfg) });
  if (verbose) echo(res.stdout, res.stderr);
  const have = res.stdout ? (res.stdout.split(/\r?\n/)[0] || "") : "";
  if (res.status !== 0) {
    console.error(
      `Warning: could not query apt version (wanted ${aptVersion}): ` +
      `${lastLine(res.stderr) || "unknown error"}`,
    );
  } else if (!have.includes(aptVersion)) {
    console.error(
      `Warning: host apt is '${have.trim()}', not ${aptVersion} ` +
      "(apt cannot re-pin itself in place).",
    );
  }
}

/** Return the last non-empty line of `text` (for compact logging). */
export function lastLine(text) {
  const lines = (text || "").trim().split(/\r?\n/).filter((ln) => ln.trim());
  return lines.length ? lines[lines.length - 1] : "";
}

/** Write each non-empty text to stdout (newline-terminated). Verbose helper. */
function echo(...texts) {
  for (const t of texts) {
    if (t) process.stdout.write(t.endsWith("\n") ? t : t + "\n");
  }
}

/** True if apt `options` already carry a Debug `-o` flag. */
function hasVerbose(options) {
  return options.some((o) => o.includes("Debug"));
}

/**
 * Run `apt-get cmd`, echoing combined output live while capturing it.
 *
 * Resolves to `[returncode, combinedOutput]`. Used in verbose mode so the user
 * watches apt in real time (e.g. a slow fetch or a hang) yet the captured text
 * still feeds the JSON report.
 */
function stream(cmd, env) {
  return new Promise((resolve) => {
    const proc = spawn("apt-get", cmd, { env, stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    const onData = (buf) => {
      const text = buf.toString();
      process.stdout.write(text);
      chunks.push(text);
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("close", (code) => resolve([code ?? 0, chunks.join("")]));
  });
}

/**
 * Attempt to download each version; write an incremental JSON report.
 *
 * Each version is downloaded into a *fresh* throwaway apt cache (so versions do
 * not interfere with one another), via `apt-get install --download-only -y
 * -o Dir::Cache=<tmp> <pkg>=<ver>`. Returns the list of result objects. If
 * `firstOnly` is set, stops after the first version that downloads
 * successfully. When `verbose` is set, apt's full output is streamed live (and
 * a Debug `-o` is added if none is present) so failures can be debugged; the
 * captured output is also folded into the report under `log`/`error`.
 */
export async function testInstallations(cachePath, pkg, indexUrl, versions, outputJson, {
  firstOnly = false, cfg = null, verbose = false,
} = {}) {
  cfg = cfg || resolveEnv();
  const env = subprocessEnv(cfg);
  const options = aptOptions(cfg);
  const results = [];
  const installable = [];

  for (let idx = 0; idx < versions.length; idx++) {
    const version = versions[idx];
    const target = `${pkg}=${version}`;
    console.log(`[${idx + 1}/${versions.length}] Attempting to install: ${target}...`);

    // Per-version throwaway cache keeps downloads independent and crash-safe.
    const tmpCache = fs.mkdtempSync(path.join(cachePath, "apt-test-"));
    fs.mkdirSync(path.join(tmpCache, "archives", "partial"), { recursive: true });
    let cmd = [
      "install",
      "--download-only",
      "-y",
      "-o",
      `Dir::Cache=${tmpCache}`,
      target,
    ];
    cmd = cmd.concat(options);
    // Bump apt's own verbosity if the user wants detail and nothing already set it.
    if (verbose && !hasVerbose(options)) cmd.push("-o", "Debug::pkgAcquire=true");

    let returncode, stdoutText, stderrText;
    if (verbose) {
      console.log(`  $ apt-get ${cmd.join(" ")}`);
      const [code, output] = await stream(cmd, env);
      returncode = code;
      stdoutText = stderrText = output; // streamed combined; same text both ways
    } else {
      const res = spawnSync("apt-get", cmd, { encoding: "utf8", env });
      returncode = res.status;
      stdoutText = res.stdout;
      stderrText = res.stderr;
    }

    if (returncode === 0) {
      console.log(`  ✅ SUCCESS: ${target}`);
      results.push({ version, status: "success", log: lastLine(stdoutText) });
      installable.push(version);
    } else {
      console.log(`  ❌ FAILED: ${target}`);
      results.push({ version, status: "failed", error: lastLine(stderrText) || "Unknown error" });
    }

    // Persist after every iteration so partial results survive a crash.
    fs.writeFileSync(outputJson, JSON.stringify(results, null, 4));

    if (firstOnly && installable.length) {
      console.log(`  First installable version found: ${installable[0]} (stopping).`);
      break;
    }
  }

  console.log(`\nTesting complete! Results saved to ${outputJson}`);
  if (installable.length) {
    console.log(`Installable versions (${installable.length}): ${installable.join(", ")}`);
  } else {
    console.log("No installable versions found.");
  }
  return results;
}

const HELP = `usage: main.mjs [-h] [--repository INDEX_URL] [--venv-dir VENV_DIR]
                [--apt-version APT_VERSION] [--output OUTPUT] [--limit LIMIT]
                [--first-only] [-v] package

Find installable versions of a package from a Debian apt repository.

positional arguments:
  package               Package name to probe (e.g. bash).

options:
  -h, --help            show this help message and exit
  --repository, --index-url INDEX_URL
                        Custom apt repository URL. Defaults to $APT_REPOSITORY,
                        then $DEBIAN_REGISTRY_URL, then the default Debian mirror.
  --venv-dir VENV_DIR   Directory for the isolated apt cache(s).
                        (default: .apt-test-install)
  --apt-version APT_VERSION
                        apt version to expect in the test env ('none' to skip the
                        check). (default: ${DEFAULT_APT_VERSION})
  --output OUTPUT       Path to write the JSON report.
                        (default: installation_report.json)
  --limit LIMIT         Only test the newest N versions (default: all).
  --first-only          Stop after the first version that installs successfully.
  -v, --verbose         Stream full apt output for every step so failures are
                        debuggable.
`;

/** Parse a `main`-style argv list into an options object (mirrors argparse). */
export function parseArgs(argv = null) {
  argv = argv === null ? process.argv.slice(2) : argv;
  const args = {
    package: null,
    indexUrl: null,
    venvDir: ".apt-test-install",
    aptVersion: DEFAULT_APT_VERSION,
    output: "installation_report.json",
    limit: null,
    firstOnly: false,
    verbose: false,
  };
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "-h" || a === "--help") {
      process.stdout.write(HELP);
      process.exit(0);
    } else if (a === "--repository" || a === "--index-url") {
      args.indexUrl = next();
    } else if (a === "--venv-dir") {
      args.venvDir = next();
    } else if (a === "--apt-version") {
      args.aptVersion = next();
    } else if (a === "--output") {
      args.output = next();
    } else if (a === "--limit") {
      args.limit = parseInt(next(), 10);
    } else if (a === "--first-only") {
      args.firstOnly = true;
    } else if (a === "-v" || a === "--verbose") {
      args.verbose = true;
    } else if (a.startsWith("-") && a !== "-") {
      console.error(`main.mjs: error: unrecognized argument: ${a}`);
      process.exit(2);
    } else {
      positionals.push(a);
    }
  }
  if (positionals.length < 1) {
    console.error("main.mjs: error: the following arguments are required: package");
    process.exit(2);
  }
  args.package = positionals[0];
  return args;
}

export async function main(argv = null) {
  const args = parseArgs(argv);

  const cfg = resolveEnv();
  const indexUrl = resolveIndexUrl(args.indexUrl, cfg);

  let versions = getAvailableVersions(args.package, indexUrl, cfg, args.verbose);
  if (!versions.length) {
    console.log("No versions found. Exiting.");
    return 1;
  }

  if (args.limit !== null && !Number.isNaN(args.limit)) {
    versions = versions.slice(0, args.limit);
  }

  console.log(`Found ${versions.length} version(s) to test (registry: ${cfg.DEBIAN_REGISTRY_NAME}).`);
  const aptVersion = String(args.aptVersion).toLowerCase() === "none" ? null : args.aptVersion;
  const cachePath = setupVenv(args.venvDir, aptVersion, cfg, args.verbose);
  await testInstallations(cachePath, args.package, indexUrl, versions, args.output, {
    firstOnly: args.firstOnly, cfg, verbose: args.verbose,
  });
  return 0;
}

// main() accepts an optional argv list. Pass one explicitly to drive the tool
// programmatically (e.g. from another script or a test); omit it and main()
// falls back to parseArgs(null), which reads from process.argv (normal CLI use).
//
// Example — probe the newest 5 versions of bash, stop at the first installable:
//     main(["bash", "--repository", "http://deb.debian.org/debian",
//           "--limit", "5", "--first-only"])
//
// Equivalent on the command line:
//     node main.mjs bash \
//         --repository http://deb.debian.org/debian --limit 5 --first-only

import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then((code) => process.exit(code)); // argv=null -> parseArgs reads process.argv
}
