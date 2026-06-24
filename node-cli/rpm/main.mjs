#!/usr/bin/env node
/**
 * Find installable versions of a package from a (custom) RPM/dnf repository.
 *
 * Discovers every version a repository advertises for a package via
 * `dnf --showduplicates list`, then attempts to download each one into an
 * isolated download directory (`dnf install --downloadonly --downloaddir`),
 * recording success/failure per version to a JSON report.
 *
 * Example:
 *     node main.mjs bash \
 *         --repository fedora
 *
 *     # only probe the newest 5 versions, stop at the first that downloads
 *     node main.mjs bash --repository fedora \
 *         --limit 5 --first-only
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// dnf version the test environment is pinned to by default. Install-tests run
// against this dnf, so it governs resolver/cache behaviour. Override via
// --dnf-version (CLI) or the `dnf` command (REPL). dnf has no in-place
// "pin yourself to version X" command, so this constant is advisory: we record
// it, surface it, and warn if the host dnf differs.
export const DEFAULT_DNF_VERSION = "4.21.1";

// Environment knobs read via process.env, each falling back to the value the
// Fedora / dnf ecosystem uses by default ("industry standard"). dnf itself reads
// some of these from the environment; we resolve them explicitly so the
// documented default still applies when the var is unset, and so they can be
// surfaced (REPL `env`) and threaded into every dnf invocation we build.
export const ENV_DEFAULTS = {
  DNF_VERBOSE: "0",                          // dnf: quiet (0 = no -v)
  DNF_CERT: "",                              // dnf: use system CA store
  DNF_INDEX: "fedora",                       // dnf: default repo id base
  DNF_REPOSITORY: "fedora",                  // dnf: --repo id / config
  DNF_TRUSTED_HOST: "",                      // dnf: no extra trusted hosts
  DNF_DEFAULT_TIMEOUT: "15",                 // dnf: timeout (s)
  DNF_RETRIES: "5",                          // dnf: retries
  RPM_REGISTRY_URL: "fedora",                // our repo fallback (repo id)
  RPM_REGISTRY_NAME: "Fedora",               // registry display name
  REQUESTS_CA_BUNDLE: "",                    // requests/urllib3: certifi
  SSL_CERT_FILE: "",                         // OpenSSL: system CA file
  SSL_CERT_DIR: "",                          // OpenSSL: system CA dir
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

/** Pick the repo id: explicit flag > DNF_REPOSITORY > RPM_REGISTRY_URL. */
export function resolveIndexUrl(explicit, cfg = null) {
  cfg = cfg || resolveEnv();
  return explicit || cfg.DNF_REPOSITORY || cfg.RPM_REGISTRY_URL || null;
}

/** Translate resolved config into dnf command-line flags. */
export function dnfOptions(cfg) {
  const opts = [];
  let level = parseInt(cfg.DNF_VERBOSE, 10);
  if (Number.isNaN(level)) level = 0;
  if (level > 0) opts.push("-" + "v".repeat(level)); // -v / -vv / -vvv ...
  // dnf reads timeouts/retries via --setopt; mirror the reference config
  // surface even where defaults already apply.
  opts.push("--setopt", `timeout=${cfg.DNF_DEFAULT_TIMEOUT}`);
  opts.push("--setopt", `retries=${cfg.DNF_RETRIES}`);
  return opts;
}

/** Child-process environment with resolved TLS cert vars applied. */
export function subprocessEnv(cfg) {
  const env = { ...process.env };
  for (const name of TLS_ENV_VARS) {
    if (cfg[name]) env[name] = cfg[name];
  }
  if (cfg.DNF_CERT) env.DNF_CERT = cfg.DNF_CERT;
  return env;
}

/**
 * Return the list of versions a repository advertises for `package`.
 *
 * Versions are returned newest-first. `dnf --showduplicates list <pkg>` prints
 * rows of `name.arch  version-release  repo`; we collect the second column
 * (`version-release`) and reverse so newest is first (dnf lists oldest-first).
 * When `verbose` is set, the dnf command and its raw output are echoed so a
 * failed or empty discovery can be debugged.
 */
export function getAvailableVersions(pkg, indexUrl, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  console.log(`Retrieving versions for '${pkg}' from ${indexUrl}...`);
  // Strip any `-v`/`-vv` from DNF_VERBOSE for this query: we only need the
  // package list rows, but verbose dnf emits a flood of metadata / cache lines
  // — enough output to overflow spawnSync's default 1MB buffer, which kills the
  // child (status=null) and yields an empty stderr.
  const cmd = [
    "--showduplicates",
    "list",
    pkg,
    ...stripVerbose(dnfOptions(cfg)),
  ];
  if (indexUrl) cmd.push("--repo", indexUrl);
  if (verbose) console.log(`  $ dnf ${cmd.join(" ")}`);

  const res = spawnSync("dnf", cmd, {
    encoding: "utf8",
    env: subprocessEnv(cfg),
    maxBuffer: 50 * 1024 * 1024, // defensive guard against future verbose output
  });
  if (res.error && res.error.code === "ENOENT") {
    console.error("Error: 'dnf' not found on PATH (run inside Fedora/RHEL).");
    process.exit(1);
  }
  if (res.status !== 0) {
    if (verbose) echo(res.stdout, res.stderr);
    // status is null when the child was killed by a signal (e.g. spawnSync
    // SIGTERM on buffer overflow) — stderr is empty in that case, so fall back
    // to the signal name / spawn error so the failure isn't reported blank.
    const detail = (res.stderr || "").trim()
      || (res.signal && `terminated by signal ${res.signal}`)
      || (res.error && res.error.message)
      || "unknown error";
    console.error(`Error running 'dnf list': ${detail}`);
    process.exit(1);
  }

  if (verbose) echo(res.stdout);
  // `dnf --showduplicates list` rows look like:
  //   bash.x86_64    5.2.26-3.fc40    fedora
  // The version-release is the second whitespace column; the first must look
  // like name.arch (contains a dot) so we skip the "Available Packages:"
  // headers. dnf lists oldest-first, so reverse for newest-first.
  const versions = [];
  for (const line of (res.stdout || "").split(/\r?\n/)) {
    const parts = line.split(/\s+/).filter(Boolean);
    if (parts.length >= 2 && parts[0].includes(".") && !line.endsWith(":")) {
      const ver = parts[1];
      // version-release tokens carry a '-'; headers/notes won't.
      if (ver.includes("-") && !versions.includes(ver)) {
        versions.push(ver);
      }
    }
  }
  if (!versions.length) {
    console.error("Could not find any versions in dnf list output.");
    return [];
  }
  versions.reverse(); // dnf emits oldest-first; we want newest-first
  return versions;
}

/**
 * Create a fresh isolated download dir if needed; return its path.
 *
 * The "isolated test env" for dnf is a throwaway download directory targeted via
 * `--downloaddir <dir>` — the analog of pip's venv. Download-tests write RPMs
 * there so the host system stays untouched. `dnfVersion` is advisory (dnf cannot
 * re-pin itself in place): when set we verify the host dnf matches and `verbose`
 * echoes the check. Pass `dnfVersion=null` to skip the check entirely.
 */
export function setupVenv(envDir, dnfVersion = DEFAULT_DNF_VERSION, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  if (!fs.existsSync(envDir)) {
    console.log(`Creating isolated dnf download dir at: ${envDir}`);
    fs.mkdirSync(envDir, { recursive: true });
  }

  // The "handle" the test step needs is the download directory itself.
  const downloadPath = envDir;

  if (dnfVersion) ensureDnfVersion(dnfVersion, cfg, verbose);
  return downloadPath;
}

/** Verify the host dnf matches `dnfVersion` (advisory only). */
function ensureDnfVersion(dnfVersion, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  console.log(`Ensuring dnf==${dnfVersion} in the test environment...`);
  const cmd = ["--version"];
  if (verbose) console.log(`  $ dnf ${cmd.join(" ")}`);
  const res = spawnSync("dnf", cmd, {
    encoding: "utf8",
    env: subprocessEnv(cfg),
    maxBuffer: 50 * 1024 * 1024, // defensive guard against future verbose output
  });
  if (verbose) echo(res.stdout, res.stderr);
  const have = res.stdout ? (res.stdout.split(/\r?\n/)[0] || "").trim() : "";
  if (res.status !== 0) {
    console.error(
      `Warning: could not query dnf version (wanted ${dnfVersion}): ${lastLine(res.stderr) || "unknown error"}`,
    );
  } else if (!have.includes(dnfVersion)) {
    console.error(
      `Warning: host dnf is '${have}', not ${dnfVersion} (dnf cannot re-pin itself in place).`,
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

/** True if dnf `options` already carry a `-v`/`-vv` flag. */
function hasVerbose(options) {
  return options.some((o) => o.startsWith("-v"));
}

/** dnf `options` with any `-v`/`-vv`/`-vvv` verbosity flag removed. */
function stripVerbose(options) {
  return options.filter((o) => !/^-v+$/.test(o));
}

/**
 * Run `dnf <cmd>`, echoing combined output live while capturing it.
 *
 * Resolves to `[returncode, combinedOutput]`. Used in verbose mode so the user
 * watches dnf in real time (e.g. a slow fetch or a hang) yet the captured text
 * still feeds the JSON report.
 */
function stream(cmd, env) {
  return new Promise((resolve) => {
    const proc = spawn("dnf", cmd, { env, stdio: ["ignore", "pipe", "pipe"] });
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
 * Each version is downloaded into a *fresh* throwaway dir (so versions do not
 * interfere with one another), via `dnf install --downloadonly
 * --downloaddir=<tmp> -y <pkg>-<ver>`. Returns the list of result objects. If
 * `firstOnly` is set, stops after the first version that downloads successfully.
 * When `verbose` is set, dnf's full output is streamed live (and a `-v` flag is
 * added if none is present) so failures can be debugged; the captured output is
 * also folded into the report under `log`/`error`.
 */
export async function testInstallations(downloadPath, pkg, indexUrl, versions, outputJson, {
  firstOnly = false, cfg = null, verbose = false,
} = {}) {
  cfg = cfg || resolveEnv();
  const env = subprocessEnv(cfg);
  const options = dnfOptions(cfg);
  const results = [];
  const installable = [];

  for (let idx = 0; idx < versions.length; idx++) {
    const version = versions[idx];
    const target = `${pkg}-${version}`;
    console.log(`[${idx + 1}/${versions.length}] Attempting to install: ${target}...`);

    // Per-version throwaway dir keeps downloads independent and crash-safe.
    const tmpDir = fs.mkdtempSync(path.join(downloadPath, "dnf-test-"));
    const cmd = [
      "install",
      "--downloadonly",
      `--downloaddir=${tmpDir}`,
      "-y",
      target,
      ...options,
    ];
    if (indexUrl) cmd.push("--repo", indexUrl);
    // Bump dnf's own verbosity if the user wants detail and nothing already set it.
    if (verbose && !hasVerbose(options)) cmd.push("-v");

    let returncode, stdoutText, stderrText;
    if (verbose) {
      console.log(`  $ dnf ${cmd.join(" ")}`);
      const [code, output] = await stream(cmd, env);
      returncode = code;
      stdoutText = stderrText = output; // streamed combined; same text both ways
    } else {
      const res = spawnSync("dnf", cmd, {
        encoding: "utf8",
        env,
        maxBuffer: 50 * 1024 * 1024, // defensive guard against future verbose output
      });
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
                [--dnf-version DNF_VERSION] [--output OUTPUT] [--limit LIMIT]
                [--first-only] [-v] package

Find installable versions of a package from an RPM/dnf repository.

positional arguments:
  package               Package name to probe (e.g. bash).

options:
  -h, --help            show this help message and exit
  --repository, --index-url INDEX_URL
                        dnf repo id to restrict to. Defaults to $DNF_REPOSITORY,
                        then $RPM_REGISTRY_URL, then the configured repos.
  --venv-dir VENV_DIR   Directory for the isolated dnf download dir(s).
                        (default: .dnf-test-install)
  --dnf-version DNF_VERSION
                        dnf version to expect in the test env ('none' to skip the
                        check). (default: ${DEFAULT_DNF_VERSION})
  --output OUTPUT       Path to write the JSON report.
                        (default: installation_report.json)
  --limit LIMIT         Only test the newest N versions (default: all).
  --first-only          Stop after the first version that installs successfully.
  -v, --verbose         Stream full dnf output for every step so failures are
                        debuggable.
`;

/** Parse a `main`-style argv list into an options object (mirrors argparse). */
export function parseArgs(argv = null) {
  argv = argv === null ? process.argv.slice(2) : argv;
  const args = {
    package: null,
    indexUrl: null,
    venvDir: ".dnf-test-install",
    dnfVersion: DEFAULT_DNF_VERSION,
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
    } else if (a === "--dnf-version") {
      args.dnfVersion = next();
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

  console.log(`Found ${versions.length} version(s) to test (registry: ${cfg.RPM_REGISTRY_NAME}).`);
  const dnfVersion = String(args.dnfVersion).toLowerCase() === "none" ? null : args.dnfVersion;
  const downloadPath = setupVenv(args.venvDir, dnfVersion, cfg, args.verbose);
  await testInstallations(downloadPath, args.package, indexUrl, versions, args.output, {
    firstOnly: args.firstOnly, cfg, verbose: args.verbose,
  });
  return 0;
}

// main() accepts an optional argv list. Pass one explicitly to drive the tool
// programmatically (e.g. from another script or a test); omit it and main()
// falls back to parseArgs(null), which reads from process.argv (normal CLI use).
//
// Example — probe the newest 5 versions of bash, stop at the first installable:
//     main(["bash", "--repository", "fedora",
//           "--limit", "5", "--first-only"])
//
// Equivalent on the command line:
//     node main.mjs bash \
//         --repository fedora --limit 5 --first-only

import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then((code) => process.exit(code)); // argv=null -> parseArgs reads process.argv
}
