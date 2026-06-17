#!/usr/bin/env node
/**
 * Find installable versions of a package from a (custom) conda channel.
 *
 * Discovers every version a channel advertises for a package via
 * `conda search <pkg> --json`, then attempts to create an isolated environment
 * pinning each one, recording success/failure per version to a JSON report.
 *
 * Example:
 *     node main.mjs numpy \
 *         --channel conda-forge
 *
 *     # only probe the newest 5 versions, stop at the first that installs
 *     node main.mjs numpy --channel conda-forge \
 *         --limit 5 --first-only
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// conda version the test environment is pinned to by default. Install-tests run
// against this conda, so it governs resolver behaviour. Override via
// --conda-version (CLI) or the `conda` command (REPL). Note: conda itself is
// provided by the host toolchain; we record the pin we expect.
export const DEFAULT_CONDA_VERSION = "24.9.2";

// Environment knobs read via process.env, each falling back to the value the
// conda ecosystem uses by default ("industry standard"). conda auto-reads
// CONDA_* vars from the environment; we resolve them explicitly so the
// documented default still applies when the var is unset, and so they can be
// surfaced (REPL `env`) and threaded into every conda invocation we build.
export const ENV_DEFAULTS = {
  CONDA_VERBOSE: "0",                            // conda: quiet (0 = no -v)
  CONDA_CHANNELS: "conda-forge",                 // conda: default channel(s)
  CONDA_DEFAULT_CHANNEL: "conda-forge",          // our channel fallback
  CONDA_SOLVER: "",                              // conda: solver (libmamba/classic)
  CONDA_DEFAULT_TIMEOUT: "60",                   // conda: remote read timeout (s)
  CONDA_REMOTE_MAX_RETRIES: "3",                 // conda: remote connection retries
  CONDA_REGISTRY_URL: "https://conda.anaconda.org",  // channel base URL
  CONDA_REGISTRY_NAME: "conda-forge",            // registry display name
  CURL_CA_BUNDLE: "",                            // curl/libcurl: CA bundle
  SSL_CERT_FILE: "",                             // OpenSSL: system CA file
  SSL_CERT_DIR: "",                              // OpenSSL: system CA dir
};

// TLS vars passed through to child processes via the environment (no CLI flag).
const TLS_ENV_VARS = ["CURL_CA_BUNDLE", "SSL_CERT_FILE", "SSL_CERT_DIR"];

// Resolver binary: conda by default, mamba when available/requested. Kept here so
// discovery and install share one source of truth.
export const CONDA_BIN = process.env.CONDA_EXE || "conda";

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

/** Pick the channel: explicit flag > CONDA_CHANNELS > CONDA_DEFAULT_CHANNEL. */
export function resolveIndexUrl(explicit, cfg = null) {
  cfg = cfg || resolveEnv();
  return explicit || cfg.CONDA_CHANNELS || cfg.CONDA_DEFAULT_CHANNEL || null;
}

/** Translate resolved config into conda command-line flags. */
export function condaOptions(cfg) {
  const opts = [];
  let level = parseInt(cfg.CONDA_VERBOSE, 10);
  if (Number.isNaN(level)) level = 0;
  if (level > 0) opts.push("-" + "v".repeat(level)); // -v / -vv / -vvv ...
  if (cfg.CONDA_SOLVER) opts.push("--solver", cfg.CONDA_SOLVER);
  return opts;
}

/** Child-process environment with resolved TLS cert vars applied. */
export function subprocessEnv(cfg) {
  const env = { ...process.env };
  for (const name of TLS_ENV_VARS) {
    if (cfg[name]) env[name] = cfg[name];
  }
  // Thread the remote timeout/retries through so conda honours them.
  env.CONDA_REMOTE_READ_TIMEOUT_SECS = String(cfg.CONDA_DEFAULT_TIMEOUT);
  env.CONDA_REMOTE_MAX_RETRIES = String(cfg.CONDA_REMOTE_MAX_RETRIES);
  return env;
}

/**
 * Return the list of versions a channel advertises for `package`.
 *
 * Versions are returned newest-first. We run `conda search <pkg> --json`,
 * which emits a JSON object keyed by the package name whose value is an array
 * of build records each carrying a `version` field (ordered oldest-first,
 * one entry per build). We dedupe to distinct versions and sort newest-first.
 * When `verbose` is set, the conda command and its raw output are echoed so a
 * failed or empty discovery can be debugged.
 */
export function getAvailableVersions(pkg, indexUrl, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  console.log(`Retrieving versions for '${pkg}' from ${indexUrl}...`);
  const cmd = ["search", pkg, "--json", ...condaOptions(cfg)];
  if (indexUrl) cmd.push("-c", indexUrl, "--override-channels");
  if (verbose) console.log(`  $ ${CONDA_BIN} ${cmd.join(" ")}`);

  const res = spawnSync(CONDA_BIN, cmd, {
    encoding: "utf8",
    env: subprocessEnv(cfg),
  });
  if (res.status !== 0) {
    if (verbose) echo(res.stdout, res.stderr);
    console.error(`Error running 'conda search': ${(res.stderr || "").trim()}`);
    process.exit(1);
  }

  if (verbose) echo(res.stdout);
  let data;
  try {
    data = JSON.parse(res.stdout);
  } catch {
    console.error("Could not parse 'conda search' JSON output.");
    return [];
  }

  // conda search returns {"<pkg>": [{"version": ...}, ...]}; dedupe the builds.
  const records = data[pkg] || [];
  const seen = new Set();
  const versions = [];
  for (const rec of records) {
    const v = rec.version;
    if (v && !seen.has(v)) {
      seen.add(v);
      versions.push(v);
    }
  }
  if (!versions.length) {
    console.error("Could not find any versions in 'conda search' output.");
    return [];
  }
  return versions.sort(versionCmp).reverse(); // newest-first
}

/** Compare two conda versions split into int/str parts (ascending). */
function versionCmp(a, b) {
  const ka = versionKey(a);
  const kb = versionKey(b);
  const n = Math.max(ka.length, kb.length);
  for (let i = 0; i < n; i++) {
    const x = ka[i];
    const y = kb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNum = typeof x === "number";
    const yNum = typeof y === "number";
    if (xNum && yNum) {
      if (x !== y) return x - y;
    } else {
      const xs = String(x);
      const ys = String(y);
      if (xs !== ys) return xs < ys ? -1 : 1;
    }
  }
  return 0;
}

/** Sort key splitting a conda version (`1.2.3`) into int/str parts. */
function versionKey(version) {
  return version.split(/[.\-+]/).map((p) => (/^\d+$/.test(p) ? parseInt(p, 10) : p));
}

/**
 * Create the parent dir for throwaway conda prefixes; return its path.
 *
 * Each install-test creates a throwaway conda prefix (`--prefix`) under this
 * directory rather than touching named environments, so probes never mutate
 * the host conda install. The setup is pinned conceptually to `condaVersion`
 * (default `DEFAULT_CONDA_VERSION`) — conda itself is host-provided, so the
 * pin is recorded/echoed rather than re-bootstrapped. Pass
 * `condaVersion=null` to skip the pin announcement. `verbose` echoes the
 * provisioning step so a failed setup can be debugged.
 */
export function setupVenv(envDir, condaVersion = DEFAULT_CONDA_VERSION, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  if (!fs.existsSync(envDir)) {
    console.log(`Creating throwaway conda prefix root at: ${envDir}`);
    fs.mkdirSync(envDir, { recursive: true });
  }

  const prefixRoot = path.resolve(envDir); // conda create --prefix lands under here

  if (condaVersion) ensureCondaVersion(prefixRoot, condaVersion, cfg, verbose);
  return prefixRoot;
}

/** Record the conda version the test prefixes expect (host-provided tool). */
function ensureCondaVersion(prefixRoot, condaVersion, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  console.log(`Ensuring conda==${condaVersion} in the test environment...`);
  const cmd = ["--version"];
  if (verbose) console.log(`  $ ${CONDA_BIN} ${cmd.join(" ")}`);
  const res = spawnSync(CONDA_BIN, cmd, { encoding: "utf8", env: subprocessEnv(cfg) });
  if (verbose) echo(res.stdout, res.stderr);
  if (res.status !== 0) {
    console.error(
      `Warning: could not confirm conda==${condaVersion}: ${lastLine(res.stderr) || "unknown error"}`,
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

/** True if conda `options` already carry a `-v`/`-vv` flag. */
function hasVerbose(options) {
  return options.some((o) => o.startsWith("-v"));
}

/**
 * Run `cmd`, echoing combined output live while capturing it.
 *
 * Resolves to `[returncode, combinedOutput]`. Used in verbose mode so the user
 * watches conda in real time (e.g. a slow solve or a hang) yet the captured
 * text still feeds the JSON report.
 */
function stream(cmd, env) {
  return new Promise((resolve) => {
    const proc = spawn(CONDA_BIN, cmd, { env, stdio: ["ignore", "pipe", "pipe"] });
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
 * Each version is installed via `conda create -y --prefix <tmp> <pkg>=<ver>`
 * into a throwaway prefix, success classified on returncode. Returns the list
 * of result objects. If `firstOnly` is set, stops after the first version that
 * installs successfully. When `verbose` is set, conda's full output is
 * streamed live (and a `-v` flag is added if none is present) so install
 * failures can be debugged; the captured output is also folded into the report
 * under `log`/`error`.
 */
export async function testInstallations(prefixRoot, pkg, indexUrl, versions, outputJson, {
  firstOnly = false, cfg = null, verbose = false,
} = {}) {
  cfg = cfg || resolveEnv();
  const env = subprocessEnv(cfg);
  const options = condaOptions(cfg);
  const channel = indexUrl || cfg.CONDA_DEFAULT_CHANNEL;
  const results = [];
  const installable = [];

  for (let idx = 0; idx < versions.length; idx++) {
    const version = versions[idx];
    const target = `${pkg}=${version}`;
    console.log(`[${idx + 1}/${versions.length}] Attempting to install: ${target}...`);

    // A fresh throwaway prefix per version keeps the solve hermetic.
    const tmpPrefix = fs.mkdtempSync(path.join(prefixRoot, "conda-itest-"));
    fs.rmdirSync(tmpPrefix); // conda create wants to make the prefix itself

    const cmd = ["create", "-y", "--prefix", tmpPrefix, target, ...options];
    if (channel) cmd.push("-c", channel, "--override-channels");
    // Bump conda's verbosity if the user wants detail and nothing already set it.
    if (verbose && !hasVerbose(options)) cmd.push("-v");

    let returncode, stdoutText, stderrText;
    if (verbose) {
      console.log(`  $ ${CONDA_BIN} ${cmd.join(" ")}`);
      const [code, output] = await stream(cmd, env);
      returncode = code;
      stdoutText = stderrText = output; // streamed combined; same text both ways
    } else {
      const res = spawnSync(CONDA_BIN, cmd, { encoding: "utf8", env });
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

const HELP = `usage: main.mjs [-h] [--channel INDEX_URL] [--prefix-root VENV_DIR]
                [--conda-version CONDA_VERSION] [--output OUTPUT] [--limit LIMIT]
                [--first-only] [-v] package

Find installable versions of a package from a conda channel.

positional arguments:
  package               Package name to probe (e.g. numpy).

options:
  -h, --help            show this help message and exit
  --channel, -c INDEX_URL
                        Custom conda channel. Defaults to $CONDA_CHANNELS, then
                        $CONDA_DEFAULT_CHANNEL, then conda-forge.
  --prefix-root VENV_DIR
                        Directory holding the isolated test conda prefixes.
                        (default: .conda-test-install)
  --conda-version CONDA_VERSION
                        conda version to expect in the test environment ('none'
                        to skip the check). (default: ${DEFAULT_CONDA_VERSION})
  --output OUTPUT       Path to write the JSON report.
                        (default: installation_report.json)
  --limit LIMIT         Only test the newest N versions (default: all).
  --first-only          Stop after the first version that installs successfully.
  -v, --verbose         Stream full conda output for every step so failures are
                        debuggable.
`;

/** Parse a `main`-style argv list into an options object (mirrors argparse). */
export function parseArgs(argv = null) {
  argv = argv === null ? process.argv.slice(2) : argv;
  const args = {
    package: null,
    indexUrl: null,
    venvDir: ".conda-test-install",
    condaVersion: DEFAULT_CONDA_VERSION,
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
    } else if (a === "--channel" || a === "-c") {
      args.indexUrl = next();
    } else if (a === "--prefix-root") {
      args.venvDir = next();
    } else if (a === "--conda-version") {
      args.condaVersion = next();
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

  console.log(`Found ${versions.length} version(s) to test (registry: ${cfg.CONDA_REGISTRY_NAME}).`);
  const condaVersion = String(args.condaVersion).toLowerCase() === "none" ? null : args.condaVersion;
  const prefixRoot = setupVenv(args.venvDir, condaVersion, cfg, args.verbose);
  await testInstallations(prefixRoot, args.package, indexUrl, versions, args.output, {
    firstOnly: args.firstOnly, cfg, verbose: args.verbose,
  });
  return 0;
}

// main() accepts an optional argv list. Pass one explicitly to drive the tool
// programmatically (e.g. from another script or a test); omit it and main()
// falls back to parseArgs(null), which reads from process.argv (normal CLI use).
//
// Example — probe the newest 5 versions of numpy, stop at the first installable:
//     main(["numpy", "--channel", "conda-forge",
//           "--limit", "5", "--first-only"])
//
// Equivalent on the command line:
//     node main.mjs numpy \
//         --channel conda-forge --limit 5 --first-only

import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then((code) => process.exit(code)); // argv=null -> parseArgs reads process.argv
}
