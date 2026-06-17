#!/usr/bin/env node
/**
 * Find installable versions of a package from a (custom) Alpine apk repository.
 *
 * Discovers every version a repository advertises for a package via
 * `apk policy`, then attempts to install each one into an isolated apk root
 * (`--root <tmp> --initdb`), recording success/failure per version to a JSON
 * report.
 *
 * Example:
 *     node main.mjs busybox \
 *         --repository https://dl-cdn.alpinelinux.org/alpine/latest-stable/main
 *
 *     # only probe the newest 5 versions, stop at the first that installs
 *     node main.mjs busybox --repository https://dl-cdn.alpinelinux.org/alpine/latest-stable/main \
 *         --limit 5 --first-only
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// apk-tools version the test environment is pinned to by default. Install-tests
// run against this apk, so it governs index/signature behaviour. Override via
// --apk-version (CLI) or the `apk` command (REPL). apk-tools has no in-place
// "pin yourself to version X" command, so this constant is advisory: we record
// it, surface it, and warn if the host apk differs.
export const DEFAULT_APK_VERSION = "2.14.4";

// Environment knobs read via process.env, each falling back to the value the
// Alpine / apk ecosystem uses by default ("industry standard"). apk itself reads
// some of these from the environment; we resolve them explicitly so the
// documented default still applies when the var is unset, and so they can be
// surfaced (REPL `env`) and threaded into every apk invocation we build.
export const ENV_DEFAULTS = {
  APK_VERBOSE: "0",                                          // apk: quiet (0 = no -v)
  APK_CERT: "",                                              // apk: use system CA store
  APK_INDEX: "https://dl-cdn.alpinelinux.org/alpine",        // apk: mirror base
  APK_REPOSITORY: "https://dl-cdn.alpinelinux.org/alpine/latest-stable/main",  // apk: repo URL
  APK_TRUSTED_HOST: "",                                      // apk: no extra trusted hosts
  APK_DEFAULT_TIMEOUT: "15",                                 // apk: 15s network timeout
  APK_RETRIES: "5",                                          // apk: connection retries
  ALPINE_REGISTRY_URL: "https://dl-cdn.alpinelinux.org/alpine/latest-stable/main",  // our repo fallback
  ALPINE_REGISTRY_NAME: "Alpine",                           // registry display name
  REQUESTS_CA_BUNDLE: "",                                    // requests/urllib3: certifi
  SSL_CERT_FILE: "",                                         // OpenSSL: system CA file
  SSL_CERT_DIR: "",                                          // OpenSSL: system CA dir
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

/** Pick the repo URL: explicit flag > APK_REPOSITORY > ALPINE_REGISTRY_URL. */
export function resolveIndexUrl(explicit, cfg = null) {
  cfg = cfg || resolveEnv();
  return explicit || cfg.APK_REPOSITORY || cfg.ALPINE_REGISTRY_URL || null;
}

/** Translate resolved config into apk command-line flags. */
export function apkOptions(cfg) {
  const opts = [];
  let level = parseInt(cfg.APK_VERBOSE, 10);
  if (Number.isNaN(level)) level = 0;
  if (level > 0) opts.push("-" + "v".repeat(level)); // -v / -vv / -vvv ...
  // apk has no per-invocation cert/timeout flags the way pip does, but it does
  // honour these as repeated knobs; keep the same translation shape so the
  // config surface mirrors the reference even where apk ignores a value.
  if (cfg.APK_TRUSTED_HOST) opts.push("--repository", cfg.APK_TRUSTED_HOST);
  return opts;
}

/** Child-process environment with resolved TLS cert vars applied. */
export function subprocessEnv(cfg) {
  const env = { ...process.env };
  for (const name of TLS_ENV_VARS) {
    if (cfg[name]) env[name] = cfg[name];
  }
  if (cfg.APK_CERT) env.APK_CERT = cfg.APK_CERT;
  return env;
}

/**
 * Return the list of versions a repository advertises for `package`.
 *
 * Versions are returned newest-first. `apk policy <pkg>` prints one block
 * per configured repository, each listing the versions that repo offers; we
 * collect the version tokens across all blocks, dedupe, and sort newest-first.
 * When `verbose` is set, the apk command and its raw output are echoed so a
 * failed or empty discovery can be debugged.
 */
export function getAvailableVersions(pkg, indexUrl, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  console.log(`Retrieving versions for '${pkg}' from ${indexUrl}...`);
  let cmd = ["policy", pkg];
  cmd = cmd.concat(apkOptions(cfg));
  if (indexUrl) cmd.push("--repository", indexUrl);
  if (verbose) console.log(`  $ apk ${cmd.join(" ")}`);

  const res = spawnSync("apk", cmd, { encoding: "utf8", env: subprocessEnv(cfg) });
  if (res.error && res.error.code === "ENOENT") {
    console.error("Error: 'apk' not found on PATH (run inside Alpine).");
    process.exit(1);
  }
  if (res.status !== 0) {
    if (verbose) echo(res.stdout, res.stderr);
    console.error(`Error running 'apk policy': ${(res.stderr || "").trim()}`);
    process.exit(1);
  }

  if (verbose) echo(res.stdout);
  // `apk policy` output looks like:
  //   busybox policy:
  //     1.36.1-r5:
  //       https://dl-cdn.alpinelinux.org/alpine/latest-stable/main
  // Each indented `<version>:` line (no scheme, ends with ':') is a candidate.
  const versions = [];
  for (const line of (res.stdout || "").split(/\r?\n/)) {
    const m = line.match(/^\s+(\S+):\s*$/);
    if (m && !m[1].includes("://")) versions.push(m[1]);
  }
  if (!versions.length) {
    console.error("Could not find any versions in apk policy output.");
    return [];
  }
  // Dedupe preserving order, then sort newest-first via apk's own comparison.
  const seen = [];
  for (const v of versions) {
    if (!seen.includes(v)) seen.push(v);
  }
  return sortVersionsNewestFirst(seen, cfg);
}

/**
 * Sort apk version strings newest-first using `apk version -t` when available.
 *
 * apk version ordering (suffixes like `-r5`, `_alpha`) is non-trivial, so we
 * ask apk itself to compare pairs; if apk is unavailable we fall back to a
 * plain reverse string sort so discovery still degrades gracefully.
 */
function sortVersionsNewestFirst(versions, cfg = null) {
  cfg = cfg || resolveEnv();

  const cmp = (a, b) => {
    const res = spawnSync("apk", ["version", "-t", a, b], {
      encoding: "utf8", env: subprocessEnv(cfg),
    });
    if (res.error) {
      return (a > b) - (a < b);
    }
    const token = (res.stdout || "").trim();
    if (token === "<") return -1;
    if (token === ">") return 1;
    return 0;
  };

  // Sorted ascending then reversed => newest-first (mirrors sorted(reverse=True)).
  return versions.slice().sort(cmp).reverse();
}

/**
 * Create a fresh isolated apk root if needed; return its root path.
 *
 * The "isolated test env" for apk is a throwaway root directory initialised
 * with `apk add --root <dir> --initdb` — the analog of pip's venv. Install
 * tests target this root so the host system stays untouched. `apkVersion`
 * is advisory (apk-tools cannot re-pin itself in place): when set we verify
 * the host apk matches and `verbose` echoes the check. Pass
 * `apkVersion=null` to skip the check entirely.
 */
export function setupVenv(envDir, apkVersion = DEFAULT_APK_VERSION, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  if (!fs.existsSync(envDir)) {
    console.log(`Creating isolated apk root at: ${envDir}`);
    fs.mkdirSync(envDir, { recursive: true });
    initdb(envDir, cfg, verbose);
  }

  // The "handle" the test step needs is the root directory itself.
  const rootPath = envDir;

  if (apkVersion) ensureApkVersion(apkVersion, cfg, verbose);
  return rootPath;
}

/** Initialise an empty apk database under `root` (idempotent best-effort). */
function initdb(root, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  const cmd = ["add", "--root", root, "--initdb", "--allow-untrusted"];
  if (verbose) console.log(`  $ apk ${cmd.join(" ")}`);
  const res = spawnSync("apk", cmd, { encoding: "utf8", env: subprocessEnv(cfg) });
  if (verbose) echo(res.stdout, res.stderr);
  if (res.status !== 0) {
    console.error(
      `Warning: could not initdb apk root at ${root}: ` +
        `${lastLine(res.stderr) || "unknown error"}`,
    );
  }
}

/** Verify the host apk-tools matches `apkVersion` (advisory only). */
function ensureApkVersion(apkVersion, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  console.log(`Ensuring apk-tools==${apkVersion} in the test environment...`);
  const cmd = ["--version"];
  if (verbose) console.log(`  $ apk ${cmd.join(" ")}`);
  const res = spawnSync("apk", cmd, { encoding: "utf8", env: subprocessEnv(cfg) });
  if (verbose) echo(res.stdout, res.stderr);
  const have = lastLine(res.stdout);
  if (res.status !== 0) {
    console.error(
      `Warning: could not query apk-tools version ` +
        `(wanted ${apkVersion}): ${lastLine(res.stderr) || "unknown error"}`,
    );
  } else if (!have.includes(apkVersion)) {
    console.error(
      `Warning: host apk-tools is '${have}', not ${apkVersion} ` +
        `(apk cannot re-pin itself in place).`,
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

/** True if apk `options` already carry a `-v`/`-vv` flag. */
function hasVerbose(options) {
  return options.some((o) => o.startsWith("-v"));
}

/**
 * Run `apk <cmd>`, echoing combined output live while capturing it.
 *
 * Resolves to `{ status, output }`. Used in verbose mode so the user watches
 * apk in real time (e.g. a slow fetch or a hang) yet the captured text still
 * feeds the JSON report.
 */
function stream(cmd, env) {
  return new Promise((resolve) => {
    const proc = spawn("apk", cmd, { env, stdio: ["ignore", "pipe", "pipe"] });
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
 * Attempt to install each version; write an incremental JSON report.
 *
 * Each version is installed into a *fresh* throwaway apk root (so versions do
 * not interfere with one another), via `apk add --root <tmp> --initdb
 * --allow-untrusted <pkg>=<ver>`. Returns the list of result objects. If
 * `firstOnly` is set, stops after the first version that installs
 * successfully. When `verbose` is set, apk's full output is streamed live
 * (and a `-v` flag is added if none is present) so install failures can be
 * debugged; the captured output is also folded into the report under
 * `log`/`error`.
 */
export async function testInstallations(rootPath, pkg, indexUrl, versions, outputJson, {
  firstOnly = false, cfg = null, verbose = false,
} = {}) {
  cfg = cfg || resolveEnv();
  const env = subprocessEnv(cfg);
  const options = apkOptions(cfg);
  const results = [];
  const installable = [];

  for (let idx = 0; idx < versions.length; idx++) {
    const version = versions[idx];
    const target = `${pkg}=${version}`;
    console.log(`[${idx + 1}/${versions.length}] Attempting to install: ${target}...`);

    // Per-version throwaway root keeps installs independent and crash-safe.
    const tmpRoot = fs.mkdtempSync(path.join(rootPath, "apk-test-"));
    let cmd = [
      "add", "--root", tmpRoot, "--initdb", "--allow-untrusted", target,
    ];
    cmd = cmd.concat(options);
    if (indexUrl) cmd.push("--repository", indexUrl);
    // Bump apk's own verbosity if the user wants detail and nothing already set it.
    if (verbose && !hasVerbose(options)) cmd.push("-v");

    let returncode, stdoutText, stderrText;
    if (verbose) {
      console.log(`  $ apk ${cmd.join(" ")}`);
      const [code, output] = await stream(cmd, env);
      returncode = code;
      stdoutText = stderrText = output; // streamed combined; same text both ways
    } else {
      const res = spawnSync("apk", cmd, { encoding: "utf8", env });
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
                [--apk-version APK_VERSION] [--output OUTPUT] [--limit LIMIT]
                [--first-only] [-v] package

Find installable versions of a package from an Alpine apk repository.

positional arguments:
  package               Package name to probe (e.g. busybox).

options:
  -h, --help            show this help message and exit
  --repository, --index-url INDEX_URL
                        Custom apk repository URL. Defaults to $APK_REPOSITORY,
                        then $ALPINE_REGISTRY_URL, then the Alpine latest-stable/main mirror.
  --venv-dir VENV_DIR   Directory for the isolated apk test root(s).
                        (default: .apk-test-install)
  --apk-version APK_VERSION
                        apk-tools version to expect in the test env ('none' to skip the
                        check). (default: ${DEFAULT_APK_VERSION})
  --output OUTPUT       Path to write the JSON report.
                        (default: installation_report.json)
  --limit LIMIT         Only test the newest N versions (default: all).
  --first-only          Stop after the first version that installs successfully.
  -v, --verbose         Stream full apk output for every step so failures are
                        debuggable.
`;

/** Parse a `main`-style argv list into an options object (mirrors argparse). */
export function parseArgs(argv = null) {
  argv = argv === null ? process.argv.slice(2) : argv;
  const args = {
    package: null,
    indexUrl: null,
    venvDir: ".apk-test-install",
    apkVersion: DEFAULT_APK_VERSION,
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
    } else if (a === "--apk-version") {
      args.apkVersion = next();
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

  console.log(`Found ${versions.length} version(s) to test (registry: ${cfg.ALPINE_REGISTRY_NAME}).`);
  const apkVersion = String(args.apkVersion).toLowerCase() === "none" ? null : args.apkVersion;
  const rootPath = setupVenv(args.venvDir, apkVersion, cfg, args.verbose);
  await testInstallations(rootPath, args.package, indexUrl, versions, args.output, {
    firstOnly: args.firstOnly, cfg, verbose: args.verbose,
  });
  return 0;
}

// main() accepts an optional argv list. Pass one explicitly to drive the tool
// programmatically (e.g. from another script or a test); omit it and main()
// falls back to parseArgs(null), which reads from process.argv (normal CLI use).
//
// Example — probe the newest 5 versions of busybox, stop at the first installable:
//     main(["busybox", "--repository", "https://dl-cdn.alpinelinux.org/alpine/latest-stable/main",
//           "--limit", "5", "--first-only"])
//
// Equivalent on the command line:
//     node main.mjs busybox \
//         --repository https://dl-cdn.alpinelinux.org/alpine/latest-stable/main --limit 5 --first-only

import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then((code) => process.exit(code)); // argv=null -> parseArgs reads process.argv
}
