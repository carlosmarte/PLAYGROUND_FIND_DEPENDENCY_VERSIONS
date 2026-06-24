#!/usr/bin/env node
/**
 * Find installable versions of a port from the (custom) vcpkg registry.
 *
 * Discovers every version the vcpkg versions database advertises for a port via
 * `versions/<first-letter>-/<port>.json`, then attempts to `vcpkg install` each
 * one in an isolated vcpkg checkout, recording success/failure per version to a
 * JSON report.
 *
 * Example:
 *     node main.mjs fmt \
 *         --registry https://raw.githubusercontent.com/microsoft/vcpkg/master
 *
 *     # only probe the newest 5 versions, stop at the first that installs
 *     node main.mjs fmt --registry https://raw.githubusercontent.com/microsoft/vcpkg/master \
 *         --limit 5 --first-only
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// vcpkg version the test environment is pinned to by default. Install-tests run
// against this vcpkg, so it governs baseline/registry behaviour. This is a soft
// pin (we only warn if vcpkg reports a different version) since the vcpkg tool is
// host-provided (a git checkout), not bootstrapped. Override via --vcpkg-version
// (CLI) or the `vcpkg` command (REPL).
export const DEFAULT_VCPKG_VERSION = "2024-10-18";

// Environment knobs read via process.env, each falling back to the value the
// vcpkg ecosystem uses by default ("industry standard"). vcpkg itself auto-reads
// VCPKG_* vars from the environment; we resolve them explicitly so the documented
// default still applies when the var is unset, and so they can be surfaced (REPL
// `env`) and threaded into every vcpkg invocation we build.
export const ENV_DEFAULTS = {
  VCPKG_VERBOSE: "0",                               // our: quiet (0 = no --debug)
  VCPKG_ROOT: "",                                   // vcpkg: checkout root (the toolchain)
  VCPKG_DEFAULT_TRIPLET: "",                         // vcpkg: target triplet (e.g. x64-linux)
  VCPKG_DOWNLOADS: "",                              // vcpkg: downloads cache dir
  VCPKG_REGISTRY: "https://raw.githubusercontent.com/microsoft/vcpkg/master",  // versions DB base
  VCPKG_DEFAULT_TIMEOUT: "15",                      // our: 15s HTTP timeout
  VCPKG_RETRIES: "5",                               // our: 5 connection retries
  PORT_REGISTRY_URL: "https://raw.githubusercontent.com/microsoft/vcpkg/master",  // our base fallback
  PORT_REGISTRY_NAME: "vcpkg",                      // registry display name
  REQUESTS_CA_BUNDLE: "",                           // requests/urllib3: certifi
  SSL_CERT_FILE: "",                                // OpenSSL: system CA file
  SSL_CERT_DIR: "",                                 // OpenSSL: system CA dir
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

/** Pick the registry base: explicit flag > VCPKG_REGISTRY > PORT_REGISTRY_URL. */
export function resolveIndexUrl(explicit, cfg = null) {
  cfg = cfg || resolveEnv();
  return explicit || cfg.VCPKG_REGISTRY || cfg.PORT_REGISTRY_URL || null;
}

/** Translate resolved config into vcpkg command-line flags. */
export function vcpkgOptions(cfg) {
  const opts = [];
  let level = parseInt(cfg.VCPKG_VERBOSE, 10);
  if (Number.isNaN(level)) level = 0;
  if (level > 0) opts.push("--debug"); // vcpkg: verbose debug output
  if (cfg.VCPKG_DEFAULT_TRIPLET) opts.push("--triplet", cfg.VCPKG_DEFAULT_TRIPLET);
  return opts;
}

/** Child-process environment with resolved TLS cert + vcpkg vars applied. */
export function subprocessEnv(cfg) {
  const env = { ...process.env };
  for (const name of TLS_ENV_VARS) {
    if (cfg[name]) env[name] = cfg[name];
  }
  if (cfg.VCPKG_ROOT) env.VCPKG_ROOT = cfg.VCPKG_ROOT;
  if (cfg.VCPKG_DOWNLOADS) env.VCPKG_DOWNLOADS = cfg.VCPKG_DOWNLOADS;
  return env;
}

/**
 * GET `url` and parse a JSON body via global `fetch` (no third-party deps).
 *
 * Resolves to the decoded JSON object, or `null` on any HTTP/parse error (the
 * caller degrades gracefully). `verbose` echoes the request and any error.
 */
async function httpGetJson(url, cfg, headers = null, verbose = false) {
  let timeout = parseInt(cfg.VCPKG_DEFAULT_TIMEOUT, 10);
  if (Number.isNaN(timeout)) timeout = 15;
  if (verbose) console.log(`  $ GET ${url}`);
  try {
    const resp = await fetch(url, {
      headers: headers || {},
      signal: AbortSignal.timeout(timeout * 1000),
    });
    return await resp.json();
  } catch (e) { // network error, JSON parse, timeout, etc.
    if (verbose) console.log(`  ! ${e.message}`);
    return null;
  }
}

/**
 * Return the list of versions the vcpkg versions DB advertises for `pkg`.
 *
 * The versions DB shards ports by first letter under
 * `versions/<first-letter>-/<port>.json`; its `versions[]` array lists
 * newest-first, which we preserve. When `verbose` is set, the request and raw
 * response are echoed so a failed or empty discovery can be debugged.
 */
export async function getAvailableVersions(pkg, indexUrl, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  console.log(`Retrieving versions for '${pkg}' from ${indexUrl}...`);
  const first = pkg ? pkg[0].toLowerCase() : "_";
  const url = `${indexUrl}/versions/${first}-/${pkg}.json`;
  const data = await httpGetJson(url, cfg, null, verbose);
  if (!data || !Array.isArray(data.versions)) {
    console.error("Could not find 'versions' in vcpkg versions DB response.");
    return [];
  }
  // Each entry carries a "version"/"version-semver"/"version-string"/"version-date".
  const versions = [];
  for (const entry of data.versions) {
    const ver = (
      entry.version
      || entry["version-semver"]
      || entry["version-string"]
      || entry["version-date"]
    );
    if (ver) versions.push(String(ver));
  }
  return versions; // DB lists newest-first already
}

/**
 * Create a fresh sandbox directory if needed; return its path.
 *
 * For vcpkg the "sandbox" is a scratch directory where each install-test writes
 * a temp manifest (`vcpkg.json`) and installs into `vcpkg_installed`. The vcpkg
 * tool is pinned to `vcpkgVersion` (default `DEFAULT_VCPKG_VERSION`) as a *soft*
 * check — we warn on mismatch rather than bootstrap a checkout. Pass
 * `vcpkgVersion=null` to skip the check. `verbose` echoes the version output so
 * a failed check can be debugged.
 */
export function setupVenv(envDir, vcpkgVersion = DEFAULT_VCPKG_VERSION, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  if (!fs.existsSync(envDir)) {
    console.log(`Creating sandbox directory at: ${envDir}`);
    fs.mkdirSync(envDir, { recursive: true });
  }

  // The "tool path" for vcpkg is the sandbox dir; temp manifests are written
  // there and the vcpkg binary is on PATH or under $VCPKG_ROOT.
  const sandboxPath = envDir;

  if (vcpkgVersion) ensureVcpkgVersion(sandboxPath, vcpkgVersion, cfg, verbose);
  return sandboxPath;
}

/** Verify the vcpkg tool reports `vcpkgVersion` (soft pin; warns). */
function ensureVcpkgVersion(sandboxPath, vcpkgVersion, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  console.log(`Ensuring vcpkg==${vcpkgVersion} in the test environment...`);
  const cmd = ["version"];
  if (verbose) console.log(`  $ vcpkg ${cmd.join(" ")}`);
  const res = spawnSync("vcpkg", cmd, {
    encoding: "utf8",
    env: subprocessEnv(cfg),
    maxBuffer: 50 * 1024 * 1024, // defensive guard against future verbose output
  });
  if (verbose) echo(res.stdout, res.stderr);
  // vcpkg prints a banner line like "vcpkg package management program version 2024-10-18-..."
  const match = (res.stdout || "").match(/version\s+([0-9][\w.\-]*)/);
  const found = match ? match[1] : "";
  if (res.status !== 0 || !found.startsWith(vcpkgVersion)) {
    // status is null when the child was killed by a signal (e.g. buffer
    // overflow SIGTERM) — no banner is printed then, so surface the signal
    // name / spawn error rather than a misleading "unknown error".
    const detail = found
      || (res.signal && `terminated by signal ${res.signal}`)
      || (res.error && res.error.message)
      || "unknown error";
    console.error(
      `Warning: could not pin vcpkg==${vcpkgVersion}: tool reports ${detail}`,
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

/** True if vcpkg `options` already carry a `--debug` flag. */
function hasVerbose(options) {
  return options.some((o) => o === "--debug");
}

/**
 * Run `vcpkg <cmd>`, echoing combined output live while capturing it.
 *
 * Resolves to `[returncode, combined_output]`. Used in verbose mode so the user
 * watches vcpkg in real time (e.g. a slow build or a hang) yet the captured text
 * still feeds the JSON report.
 */
function stream(cmd, env, cwd = null) {
  return new Promise((resolve) => {
    const proc = spawn("vcpkg", cmd, { env, cwd: cwd || undefined, stdio: ["ignore", "pipe", "pipe"] });
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
 * Attempt to `vcpkg install` each version; write an incremental JSON report.
 *
 * Returns the list of result objects. If `firstOnly` is set, stops after the
 * first version that installs successfully. When `verbose` is set, vcpkg's full
 * output is streamed live (and a `--debug` flag is added if none is present) so
 * install failures can be debugged; the captured output is also folded into the
 * report under `log`/`error`.
 *
 * Each version installs in classic mode pinned via `--version` so the vcpkg
 * versioning resolver fetches exactly that port version from the registry.
 */
export async function testInstallations(sandboxPath, pkg, indexUrl, versions, outputJson, {
  firstOnly = false, cfg = null, verbose = false,
} = {}) {
  cfg = cfg || resolveEnv();
  const env = subprocessEnv(cfg);
  const options = vcpkgOptions(cfg);
  const results = [];
  const installable = [];

  for (let idx = 0; idx < versions.length; idx++) {
    const version = versions[idx];
    const target = `${pkg}@${version}`;
    console.log(`[${idx + 1}/${versions.length}] Attempting to install: ${target}...`);

    const cmd = ["install", `${pkg}`, "--version", version, ...options];
    // Bump vcpkg's own verbosity if the user wants detail and nothing set it.
    if (verbose && !hasVerbose(options)) cmd.push("--debug");

    let returncode, stdoutText, stderrText, signal = null, spawnError = null;
    if (verbose) {
      console.log(`  $ vcpkg ${cmd.join(" ")}  (cwd=${sandboxPath})`);
      const [code, output] = await stream(cmd, env, sandboxPath);
      returncode = code;
      stdoutText = stderrText = output; // streamed combined; same text both ways
    } else {
      const res = spawnSync("vcpkg", cmd, {
        encoding: "utf8",
        env,
        cwd: sandboxPath,
        maxBuffer: 50 * 1024 * 1024, // defensive guard against future verbose output
      });
      returncode = res.status;
      stdoutText = res.stdout;
      stderrText = res.stderr;
      signal = res.signal; // set when status is null (child killed by signal)
      spawnError = res.error;
    }

    if (returncode === 0) {
      console.log(`  ✅ SUCCESS: ${target}`);
      results.push({ version, status: "success", log: lastLine(stdoutText) });
      installable.push(version);
    } else {
      console.log(`  ❌ FAILED: ${target}`);
      // A null returncode means the child was killed by a signal (e.g. buffer
      // overflow SIGTERM) — stderr is empty then, so fall back to the signal
      // name / spawn error so the failure isn't recorded blank.
      const error = lastLine(stderrText)
        || (signal && `terminated by signal ${signal}`)
        || (spawnError && spawnError.message)
        || "Unknown error";
      results.push({ version, status: "failed", error });
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

const HELP = `usage: main.mjs [-h] [--registry INDEX_URL] [--venv-dir VENV_DIR]
                [--vcpkg-version VCPKG_VERSION] [--output OUTPUT] [--limit LIMIT]
                [--first-only] [-v] package

Find installable versions of a port from the vcpkg registry.

positional arguments:
  package               Port name to probe (e.g. fmt).

options:
  -h, --help            show this help message and exit
  --registry INDEX_URL  Custom vcpkg versions-DB base URL. Defaults to
                        $VCPKG_REGISTRY, then $PORT_REGISTRY_URL, then the
                        microsoft/vcpkg master tree.
  --venv-dir VENV_DIR   Directory for the isolated install sandbox.
                        (default: .venv-test-install)
  --vcpkg-version VCPKG_VERSION
                        vcpkg version to expect ('none' to skip the check).
                        (default: ${DEFAULT_VCPKG_VERSION})
  --output OUTPUT       Path to write the JSON report.
                        (default: installation_report.json)
  --limit LIMIT         Only test the newest N versions (default: all).
  --first-only          Stop after the first version that installs successfully.
  -v, --verbose         Stream full vcpkg output for every step so failures are
                        debuggable.
`;

/** Parse a `main`-style argv list into an options object (mirrors argparse). */
export function parseArgs(argv = null) {
  argv = argv === null ? process.argv.slice(2) : argv;
  const args = {
    package: null,
    indexUrl: null,
    venvDir: ".venv-test-install",
    vcpkgVersion: DEFAULT_VCPKG_VERSION,
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
    } else if (a === "--registry") {
      args.indexUrl = next();
    } else if (a === "--venv-dir") {
      args.venvDir = next();
    } else if (a === "--vcpkg-version") {
      args.vcpkgVersion = next();
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

  let versions = await getAvailableVersions(args.package, indexUrl, cfg, args.verbose);
  if (!versions.length) {
    console.log("No versions found. Exiting.");
    return 1;
  }

  if (args.limit !== null && !Number.isNaN(args.limit)) {
    versions = versions.slice(0, args.limit);
  }

  console.log(`Found ${versions.length} version(s) to test (registry: ${cfg.PORT_REGISTRY_NAME}).`);
  const vcpkgVersion = String(args.vcpkgVersion).toLowerCase() === "none" ? null : args.vcpkgVersion;
  const sandboxPath = setupVenv(args.venvDir, vcpkgVersion, cfg, args.verbose);
  await testInstallations(sandboxPath, args.package, indexUrl, versions, args.output, {
    firstOnly: args.firstOnly, cfg, verbose: args.verbose,
  });
  return 0;
}

// main() accepts an optional argv list. Pass one explicitly to drive the tool
// programmatically (e.g. from another script or a test); omit it and main()
// falls back to parseArgs(null), which reads from process.argv (normal CLI use).
//
// Example — probe the newest 5 versions of fmt, stop at the first installable:
//     main(["fmt", "--registry", "https://raw.githubusercontent.com/microsoft/vcpkg/master",
//           "--limit", "5", "--first-only"])
//
// Equivalent on the command line:
//     node main.mjs fmt \
//         --registry https://raw.githubusercontent.com/microsoft/vcpkg/master --limit 5 --first-only

import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then((code) => process.exit(code)); // argv=null -> parseArgs reads process.argv
}
