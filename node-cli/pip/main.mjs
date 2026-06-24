#!/usr/bin/env node
/**
 * Find installable versions of a package from a (custom) package registry.
 *
 * Discovers every version a registry advertises for a package via
 * `pip index versions`, then attempts to install each one in an isolated
 * virtual environment, recording success/failure per version to a JSON report.
 *
 * Example:
 *     node main.mjs numpy \
 *         --index-url https://my-registry.example.com/simple
 *
 *     # only probe the newest 5 versions, stop at the first that installs
 *     node main.mjs numpy --index-url https://reg/simple \
 *         --limit 5 --first-only
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// Interpreter used to invoke `-m pip` (mirrors the python's sys.executable).
const PYTHON = process.env.PYTHON || "python3";

// pip version the test environment is pinned to by default. Install-tests run
// against this pip, so it governs resolver/cooldown behaviour. Override via
// --pip-version (CLI) or the `pip` command (REPL).
export const DEFAULT_PIP_VERSION = "26.1.1";

// Environment knobs read via process.env, each falling back to the value the
// Python packaging / TLS ecosystem uses by default ("industry standard"). pip
// itself auto-reads PIP_* vars from the environment; we resolve them explicitly
// so the documented default still applies when the var is unset, and so they can
// be surfaced (REPL `env`) and threaded into every pip invocation we build.
export const ENV_DEFAULTS = {
  PIP_VERBOSE: "0",                               // pip: quiet (0 = no -v)
  PIP_CERT: "",                                   // pip: use certifi/system store
  PIP_INDEX: "https://pypi.org/pypi",             // pip: legacy XML-RPC/JSON base
  PIP_INDEX_URL: "https://pypi.org/simple",       // pip: PEP 503 simple index
  PIP_TRUSTED_HOST: "",                           // pip: no extra trusted hosts
  PIP_DEFAULT_TIMEOUT: "15",                      // pip: 15s socket timeout
  PIP_RETRIES: "5",                               // pip: 5 connection retries
  PYTHON_REGISTRY_URL: "https://pypi.org/simple", // our index-url fallback
  PYTHON_REGISTRY_NAME: "PyPI",                   // registry display name
  REQUESTS_CA_BUNDLE: "",                         // requests/urllib3: certifi
  SSL_CERT_FILE: "",                              // OpenSSL: system CA file
  SSL_CERT_DIR: "",                               // OpenSSL: system CA dir
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

/** Pick the index URL: explicit flag > PIP_INDEX_URL > PYTHON_REGISTRY_URL. */
export function resolveIndexUrl(explicit, cfg = null) {
  cfg = cfg || resolveEnv();
  return explicit || cfg.PIP_INDEX_URL || cfg.PYTHON_REGISTRY_URL || null;
}

/** Translate resolved config into pip command-line flags. */
export function pipOptions(cfg) {
  const opts = [];
  let level = parseInt(cfg.PIP_VERBOSE, 10);
  if (Number.isNaN(level)) level = 0;
  if (level > 0) opts.push("-" + "v".repeat(level)); // -v / -vv / -vvv ...
  if (cfg.PIP_CERT) opts.push("--cert", cfg.PIP_CERT);
  if (cfg.PIP_TRUSTED_HOST) opts.push("--trusted-host", cfg.PIP_TRUSTED_HOST);
  opts.push("--timeout", String(cfg.PIP_DEFAULT_TIMEOUT));
  opts.push("--retries", String(cfg.PIP_RETRIES));
  return opts;
}

/** Child-process environment with resolved TLS cert vars applied. */
export function subprocessEnv(cfg) {
  const env = { ...process.env };
  for (const name of TLS_ENV_VARS) {
    if (cfg[name]) env[name] = cfg[name];
  }
  if (cfg.PIP_CERT) env.PIP_CERT = cfg.PIP_CERT;
  return env;
}

/**
 * Return the list of versions a registry advertises for `pkg`.
 *
 * Versions are returned newest-first, mirroring `pip index versions`. When
 * `verbose` is set, the pip command and its raw output are echoed so a failed
 * or empty discovery can be debugged.
 */
export function getAvailableVersions(pkg, indexUrl, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  console.log(`Retrieving versions for '${pkg}' from ${indexUrl}...`);
  // Strip any `-v`/`-vv` from PIP_VERBOSE for this query: we only need the
  // single "Available versions:" line, but verbose pip emits a line per
  // registry link — enough output to overflow spawnSync's default 1MB buffer,
  // which kills the child (status=null) and yields an empty stderr.
  const cmd = ["-m", "pip", "index", "versions", pkg, ...stripVerbose(pipOptions(cfg))];
  if (indexUrl) cmd.push("--index-url", indexUrl);
  if (verbose) console.log(`  $ ${PYTHON} ${cmd.join(" ")}`);

  const res = spawnSync(PYTHON, cmd, {
    encoding: "utf8",
    env: subprocessEnv(cfg),
    maxBuffer: 50 * 1024 * 1024, // defensive guard against future verbose output
  });
  if (res.status !== 0) {
    if (verbose) echo(res.stdout, res.stderr);
    // status is null when the child was killed by a signal (e.g. spawnSync
    // SIGTERM on buffer overflow) — stderr is empty in that case, so fall back
    // to the signal name / spawn error so the failure isn't reported blank.
    const detail = (res.stderr || "").trim()
      || (res.signal && `terminated by signal ${res.signal}`)
      || (res.error && res.error.message)
      || "unknown error";
    console.error(`Error running 'pip index versions': ${detail}`);
    process.exit(1);
  }

  if (verbose) echo(res.stdout);
  const match = (res.stdout || "").match(/Available versions:\s*(.*)/);
  if (!match) {
    console.error("Could not find 'Available versions:' in pip output.");
    return [];
  }
  return match[1].split(",").map((v) => v.trim()).filter((v) => v);
}

/**
 * Create a fresh virtual environment if needed; return its pip path.
 *
 * The venv's pip is pinned to `pipVersion` (default `DEFAULT_PIP_VERSION`)
 * so install-tests run against a known pip. Pass `pipVersion=null` to keep
 * whatever pip the venv was bootstrapped with. `verbose` echoes the pip-pin
 * output so a failed pin can be debugged. `indexUrl` is the resolved registry
 * the pin is fetched from, so the pinned pip comes from the SAME registry the
 * version probe and install-tests use (pass `null` for pip's default).
 */
export function setupVenv(envDir, pipVersion = DEFAULT_PIP_VERSION, cfg = null, verbose = false, indexUrl = null) {
  cfg = cfg || resolveEnv();
  if (!fs.existsSync(envDir)) {
    console.log(`Creating virtual environment at: ${envDir}`);
    const res = spawnSync(PYTHON, ["-m", "venv", envDir], {
      encoding: "utf8",
      env: subprocessEnv(cfg),
    });
    if (res.status !== 0 && verbose) echo(res.stdout, res.stderr);
  }

  let pipPath;
  if (process.platform === "win32") { // Windows
    pipPath = path.join(envDir, "Scripts", "pip.exe");
  } else {
    pipPath = path.join(envDir, "bin", "pip"); // macOS / Linux
  }

  if (pipVersion) ensurePipVersion(pipPath, pipVersion, cfg, verbose, indexUrl);
  return pipPath;
}

/** Pin the venv's pip to `pipVersion` (fetched from the resolved registry). */
function ensurePipVersion(pipPath, pipVersion, cfg = null, verbose = false, indexUrl = null) {
  cfg = cfg || resolveEnv();
  console.log(`Ensuring pip==${pipVersion} in the test environment...`);
  const cmd = [
    "install", "--disable-pip-version-check", `pip==${pipVersion}`, ...pipOptions(cfg),
  ];
  // Fetch the pinned pip from the same registry as discovery / install-tests,
  // not whatever ambient default pip would otherwise use.
  if (indexUrl) cmd.push("--index-url", indexUrl);
  if (verbose) console.log(`  $ ${pipPath} ${cmd.join(" ")}`);
  const res = spawnSync(pipPath, cmd, { encoding: "utf8", env: subprocessEnv(cfg) });
  if (verbose) echo(res.stdout, res.stderr);
  if (res.status !== 0) {
    console.error(
      `Warning: could not pin pip==${pipVersion}: ${lastLine(res.stderr) || "unknown error"}`,
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

/** True if pip `options` already carry a `-v`/`-vv` flag. */
function hasVerbose(options) {
  return options.some((o) => o.startsWith("-v"));
}

/** pip `options` with any `-v`/`-vv`/`-vvv` verbosity flag removed. */
function stripVerbose(options) {
  return options.filter((o) => !/^-v+$/.test(o));
}

/**
 * Run `cmd`, echoing combined output live while capturing it.
 *
 * Resolves to `[returncode, combinedOutput]`. Used in verbose mode so the user
 * watches pip in real time (e.g. a slow build or a hang) yet the captured text
 * still feeds the JSON report.
 */
function stream(file, cmd, env) {
  return new Promise((resolve) => {
    const proc = spawn(file, cmd, { env, stdio: ["ignore", "pipe", "pipe"] });
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
 * Returns the list of result objects. If `firstOnly` is set, stops after
 * the first version that installs successfully. When `verbose` is set, pip's
 * full output is streamed live (and a `--verbose -v` flag is added if none is
 * present) so install failures can be debugged; the captured output is also
 * folded into the report under `log`/`error`.
 */
export async function testInstallations(pipPath, pkg, indexUrl, versions, outputJson, {
  firstOnly = false, cfg = null, verbose = false,
} = {}) {
  cfg = cfg || resolveEnv();
  const env = subprocessEnv(cfg);
  const options = pipOptions(cfg);
  const results = [];
  const installable = [];

  for (let idx = 0; idx < versions.length; idx++) {
    const version = versions[idx];
    const target = `${pkg}==${version}`;
    console.log(`[${idx + 1}/${versions.length}] Attempting to install: ${target}...`);

    const cmd = [
      "install", target, "--force-reinstall", "--no-cache-dir", ...options,
    ];
    if (indexUrl) cmd.push("--index-url", indexUrl);
    // Bump pip's own verbosity if the user wants detail and nothing already set it.
    if (verbose && !hasVerbose(options)) cmd.push("-v");

    let returncode, stdoutText, stderrText;
    if (verbose) {
      console.log(`  $ ${pipPath} ${cmd.join(" ")}`);
      const [code, output] = await stream(pipPath, cmd, env);
      returncode = code;
      stdoutText = stderrText = output; // streamed combined; same text both ways
    } else {
      const res = spawnSync(pipPath, cmd, { encoding: "utf8", env });
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

const HELP = `usage: main.mjs [-h] [--index-url INDEX_URL] [--venv-dir VENV_DIR]
                [--pip-version PIP_VERSION] [--output OUTPUT] [--limit LIMIT]
                [--first-only] [-v] package

Find installable versions of a package from a registry.

positional arguments:
  package               Package name to probe (e.g. numpy).

options:
  -h, --help            show this help message and exit
  --index-url INDEX_URL
                        Custom registry simple index URL. Defaults to $PIP_INDEX_URL,
                        then $PYTHON_REGISTRY_URL, then https://pypi.org/simple.
  --venv-dir VENV_DIR   Directory for the isolated test virtual environment.
                        (default: .venv-test-install)
  --pip-version PIP_VERSION
                        pip version to pin in the test venv ('none' to keep the
                        bootstrapped pip). (default: ${DEFAULT_PIP_VERSION})
  --output OUTPUT       Path to write the JSON report.
                        (default: installation_report.json)
  --limit LIMIT         Only test the newest N versions (default: all).
  --first-only          Stop after the first version that installs successfully.
  -v, --verbose         Stream full pip output for every step so failures are
                        debuggable.
`;

/** Parse a `main`-style argv list into an options object (mirrors argparse). */
export function parseArgs(argv = null) {
  argv = argv === null ? process.argv.slice(2) : argv;
  const args = {
    package: null,
    indexUrl: null,
    venvDir: ".venv-test-install",
    pipVersion: DEFAULT_PIP_VERSION,
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
    } else if (a === "--index-url") {
      args.indexUrl = next();
    } else if (a === "--venv-dir") {
      args.venvDir = next();
    } else if (a === "--pip-version") {
      args.pipVersion = next();
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

  console.log(`Found ${versions.length} version(s) to test (registry: ${cfg.PYTHON_REGISTRY_NAME}).`);
  const pipVersion = String(args.pipVersion).toLowerCase() === "none" ? null : args.pipVersion;
  const pipPath = setupVenv(args.venvDir, pipVersion, cfg, args.verbose, indexUrl);
  await testInstallations(pipPath, args.package, indexUrl, versions, args.output, {
    firstOnly: args.firstOnly, cfg, verbose: args.verbose,
  });
  return 0;
}

// main() accepts an optional argv list. Pass one explicitly to drive the tool
// programmatically (e.g. from another script or a test); omit it and main()
// falls back to parseArgs(null), which reads from process.argv (normal CLI use).
//
// Example — probe the newest 5 versions of numpy, stop at the first installable:
//     main(["numpy", "--index-url", "https://reg.example.com/simple",
//           "--limit", "5", "--first-only"])
//
// Equivalent on the command line:
//     node main.mjs numpy \
//         --index-url https://reg.example.com/simple --limit 5 --first-only

import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then((code) => process.exit(code)); // argv=null -> parseArgs reads process.argv
}
