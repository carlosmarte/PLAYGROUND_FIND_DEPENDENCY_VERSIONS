#!/usr/bin/env node
/**
 * Find installable versions of a package from a (custom) package registry.
 *
 * Discovers every version a registry advertises for a package via
 * `uv pip index versions`, then attempts to install each one in an isolated
 * `uv venv` sandbox, recording success/failure per version to a JSON report.
 * When the `uv pip index versions` command yields nothing, discovery falls back
 * to the PyPI simple/JSON API over global `fetch`.
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

// uv version the test environment is pinned to by default. Install-tests run
// against this uv, so it governs resolver behaviour. Override via --uv-version
// (CLI) or the `uv` command (REPL).
export const DEFAULT_UV_VERSION = "0.4.18";

// Environment knobs read via process.env, each falling back to the value the
// Python packaging / TLS ecosystem uses by default ("industry standard"). uv
// itself auto-reads UV_* vars from the environment; we resolve them explicitly
// so the documented default still applies when the var is unset, and so they can
// be surfaced (REPL `env`) and threaded into every uv invocation we build.
export const ENV_DEFAULTS = {
  UV_VERBOSE: "0",                               // uv: quiet (0 = no -v)
  UV_NATIVE_TLS: "",                             // uv: "" => use built-in TLS store
  UV_INDEX_URL: "https://pypi.org/simple",       // uv: PEP 503 simple index
  UV_EXTRA_INDEX_URL: "",                        // uv: extra simple indexes
  UV_HTTP_TIMEOUT: "15",                         // uv: 15s socket timeout
  UV_CONCURRENT_DOWNLOADS: "5",                  // uv: parallel download slots
  PYTHON_REGISTRY_URL: "https://pypi.org/simple",  // our index-url fallback
  PYTHON_REGISTRY_NAME: "PyPI",                  // registry display name
  REQUESTS_CA_BUNDLE: "",                        // requests/urllib3: certifi
  SSL_CERT_FILE: "",                             // OpenSSL: system CA file
  SSL_CERT_DIR: "",                              // OpenSSL: system CA dir
};

// JSON metadata base used for the version-discovery fallback (global fetch).
export const PYPI_JSON_BASE = "https://pypi.org/pypi";

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

/** Pick the index URL: explicit flag > UV_INDEX_URL > PYTHON_REGISTRY_URL. */
export function resolveIndexUrl(explicit, cfg = null) {
  cfg = cfg || resolveEnv();
  return explicit || cfg.UV_INDEX_URL || cfg.PYTHON_REGISTRY_URL || null;
}

/** Translate resolved config into uv command-line flags. */
export function uvOptions(cfg) {
  const opts = [];
  let level = parseInt(cfg.UV_VERBOSE, 10);
  if (Number.isNaN(level)) level = 0;
  if (level > 0) opts.push("-" + "v".repeat(level)); // -v / -vv / -vvv ...
  if (cfg.UV_NATIVE_TLS) opts.push("--native-tls");
  return opts;
}

/** Child-process environment with resolved TLS cert vars applied. */
export function subprocessEnv(cfg) {
  const env = { ...process.env };
  for (const name of TLS_ENV_VARS) {
    if (cfg[name]) env[name] = cfg[name];
  }
  env.UV_HTTP_TIMEOUT = String(cfg.UV_HTTP_TIMEOUT);
  return env;
}

/**
 * Return the list of versions a registry advertises for `pkg`.
 *
 * Versions are returned newest-first, mirroring `uv pip index versions`.
 * When that command yields nothing usable, discovery falls back to the PyPI
 * JSON API over global `fetch`. When `verbose` is set, the uv command and its
 * raw output are echoed so a failed or empty discovery can be debugged.
 */
export async function getAvailableVersions(pkg, indexUrl, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  console.log(`Retrieving versions for '${pkg}' from ${indexUrl}...`);
  const cmd = ["pip", "index", "versions", pkg, ...uvOptions(cfg)];
  if (indexUrl) cmd.push("--index-url", indexUrl);
  if (verbose) console.log(`  $ uv ${cmd.join(" ")}`);

  const res = spawnSync("uv", cmd, { encoding: "utf8", env: subprocessEnv(cfg) });
  if (res.error && res.error.code === "ENOENT") {
    if (verbose) console.log("  uv not found on PATH; falling back to PyPI JSON API.");
    return versionsFromPypi(pkg, cfg, verbose);
  }
  if (res.status !== 0) {
    if (verbose) echo(res.stdout, res.stderr);
    console.error(`'uv pip index versions' failed: ${(res.stderr || "").trim()}; ` +
      "falling back to PyPI JSON API.");
    return versionsFromPypi(pkg, cfg, verbose);
  }

  if (verbose) echo(res.stdout);
  const match = (res.stdout || "").match(/Available versions:\s*(.*)/);
  if (!match) {
    if (verbose) console.log("  No 'Available versions:' line; falling back to PyPI JSON API.");
    return versionsFromPypi(pkg, cfg, verbose);
  }
  return match[1].split(",").map((v) => v.trim()).filter((v) => v);
}

/** Fallback discovery: PyPI JSON API `releases` keys, newest-first. */
export async function versionsFromPypi(pkg, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  const url = `${PYPI_JSON_BASE}/${pkg}/json`;
  if (verbose) console.log(`  $ GET ${url}`);
  let data;
  try {
    const timeout = parseInt(cfg.UV_HTTP_TIMEOUT, 10) || 15;
    const resp = await fetch(url, { signal: AbortSignal.timeout(timeout * 1000) });
    data = await resp.json();
  } catch (e) { // network error, HTTP, JSON, timeout
    console.error(`Error querying PyPI JSON API: ${e.message}`);
    return [];
  }
  const releases = data.releases || {};
  if (!Object.keys(releases).length) {
    console.error("Could not find 'releases' in PyPI JSON output.");
    return [];
  }
  return Object.keys(releases).sort(versionCompare).reverse();
}

/** Best-effort sort key compare: split into numeric/non-numeric tokens. */
export function versionCompare(a, b) {
  const ka = versionKey(a);
  const kb = versionKey(b);
  for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
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

/** Best-effort sort key: split into numeric/non-numeric tokens. */
export function versionKey(version) {
  return version.split(/[.\-_+]/).map((t) => (/^\d+$/.test(t) ? parseInt(t, 10) : t));
}

/**
 * Create a fresh `uv venv` sandbox if needed; return the venv python path.
 *
 * The sandbox is built with `uv venv` and install-tests run `uv pip install`
 * into it (via `--python`) against the pinned `uvVersion` (default
 * `DEFAULT_UV_VERSION`) so they exercise a known resolver. Pass
 * `uvVersion=null` to keep whatever uv is on PATH. `verbose` echoes the
 * uv-version output so a mismatch can be debugged.
 */
export function setupVenv(envDir, uvVersion = DEFAULT_UV_VERSION, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  if (!fs.existsSync(envDir)) {
    console.log(`Creating uv virtual environment at: ${envDir}`);
    const cmd = ["venv", envDir, ...uvOptions(cfg)];
    if (verbose) console.log(`  $ uv ${cmd.join(" ")}`);
    const res = spawnSync("uv", cmd, { encoding: "utf8", env: subprocessEnv(cfg) });
    if (verbose) echo(res.stdout, res.stderr);
    if (res.status !== 0) {
      console.error(
        `Warning: could not create uv venv: ${lastLine(res.stderr) || "unknown error"}`,
      );
    }
  }

  let pyPath;
  if (process.platform === "win32") { // Windows
    pyPath = path.join(envDir, "Scripts", "python.exe");
  } else {
    pyPath = path.join(envDir, "bin", "python"); // macOS / Linux
  }

  if (uvVersion) ensureUvVersion(uvVersion, cfg, verbose);
  return pyPath;
}

/** Report whether uv on PATH matches the requested `uvVersion`. */
function ensureUvVersion(uvVersion, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  console.log(`Ensuring uv==${uvVersion} for the test environment...`);
  const cmd = ["--version"];
  if (verbose) console.log(`  $ uv ${cmd.join(" ")}`);
  const res = spawnSync("uv", cmd, { encoding: "utf8", env: subprocessEnv(cfg) });
  if (verbose) echo(res.stdout, res.stderr);
  if (res.status !== 0) {
    console.error(
      `Warning: could not verify uv==${uvVersion}: ${lastLine(res.stderr) || "unknown error"}`,
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

/** True if uv `options` already carry a `-v`/`-vv` flag. */
function hasVerbose(options) {
  return options.some((o) => o.startsWith("-v"));
}

/**
 * Run `uv <cmd>`, echoing combined output live while capturing it.
 *
 * Resolves to `[returncode, combined_output]`. Used in verbose mode so the user
 * watches uv in real time (e.g. a slow build or a hang) yet the captured text
 * still feeds the JSON report.
 */
function stream(cmd, env) {
  return new Promise((resolve) => {
    const proc = spawn("uv", cmd, { env, stdio: ["ignore", "pipe", "pipe"] });
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
 * `pyPath` is the venv python path returned by `setupVenv`. Returns the list of
 * result objects. If `firstOnly` is set, stops after the first version that
 * installs successfully. When `verbose` is set, uv's full output is streamed
 * live (and a `-v` flag is added if none is present) so install failures can be
 * debugged; the captured output is also folded into the report under
 * `log`/`error`.
 */
export async function testInstallations(pyPath, pkg, indexUrl, versions, outputJson, {
  firstOnly = false, cfg = null, verbose = false,
} = {}) {
  cfg = cfg || resolveEnv();
  const env = subprocessEnv(cfg);
  const options = uvOptions(cfg);
  const results = [];
  const installable = [];

  for (let idx = 0; idx < versions.length; idx++) {
    const version = versions[idx];
    const target = `${pkg}==${version}`;
    console.log(`[${idx + 1}/${versions.length}] Attempting to install: ${target}...`);

    const cmd = [
      "pip", "install", target, "--python", pyPath, "--reinstall", "--no-cache",
      ...options,
    ];
    if (indexUrl) cmd.push("--index-url", indexUrl);
    // Bump uv's own verbosity if the user wants detail and nothing already set it.
    if (verbose && !hasVerbose(options)) cmd.push("-v");

    let returncode, stdoutText, stderrText;
    if (verbose) {
      console.log(`  $ uv ${cmd.join(" ")}`);
      const [code, output] = await stream(cmd, env);
      returncode = code;
      stdoutText = stderrText = output; // streamed combined; same text both ways
    } else {
      const res = spawnSync("uv", cmd, { encoding: "utf8", env });
      returncode = res.status;
      stdoutText = res.stdout;
      stderrText = res.stderr;
    }

    if (returncode === 0) {
      console.log(`  ✅ SUCCESS: ${target}`);
      results.push({ version, status: "success", log: lastLine(stdoutText) || lastLine(stderrText) });
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
                [--uv-version UV_VERSION] [--output OUTPUT] [--limit LIMIT]
                [--first-only] [-v] package

Find installable versions of a package from a registry.

positional arguments:
  package               Package name to probe (e.g. numpy).

options:
  -h, --help            show this help message and exit
  --index-url INDEX_URL
                        Custom registry simple index URL. Defaults to $UV_INDEX_URL,
                        then $PYTHON_REGISTRY_URL, then https://pypi.org/simple.
  --venv-dir VENV_DIR   Directory for the isolated uv venv sandbox.
                        (default: .venv-test-install)
  --uv-version UV_VERSION
                        uv version expected on PATH ('none' to keep whatever is
                        installed). (default: ${DEFAULT_UV_VERSION})
  --output OUTPUT       Path to write the JSON report.
                        (default: installation_report.json)
  --limit LIMIT         Only test the newest N versions (default: all).
  --first-only          Stop after the first version that installs successfully.
  -v, --verbose         Stream full uv output for every step so failures are
                        debuggable.
`;

/** Parse a `main`-style argv list into an options object (mirrors argparse). */
export function parseArgs(argv = null) {
  argv = argv === null ? process.argv.slice(2) : argv;
  const args = {
    package: null,
    indexUrl: null,
    venvDir: ".venv-test-install",
    uvVersion: DEFAULT_UV_VERSION,
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
    } else if (a === "--uv-version") {
      args.uvVersion = next();
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

  console.log(`Found ${versions.length} version(s) to test (registry: ${cfg.PYTHON_REGISTRY_NAME}).`);
  const uvVersion = String(args.uvVersion).toLowerCase() === "none" ? null : args.uvVersion;
  const pyPath = setupVenv(args.venvDir, uvVersion, cfg, args.verbose);
  await testInstallations(pyPath, args.package, indexUrl, versions, args.output, {
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
