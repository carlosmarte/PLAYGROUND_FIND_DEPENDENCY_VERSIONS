#!/usr/bin/env node
/**
 * Find installable versions of a package from a (custom) Poetry source.
 *
 * Discovers every version a registry advertises for a package via the PyPI JSON
 * API (`https://pypi.org/pypi/<pkg>/json` — the `releases` keys, sorted
 * newest-first), then attempts to add each one to an isolated throwaway Poetry
 * project (`poetry init -n` then `poetry add <pkg>==<ver>`), recording
 * success/failure per version to a JSON report.
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

// poetry version the test environment is pinned to by default. Install-tests run
// against this poetry, so it governs resolver behaviour. Override via
// --poetry-version (CLI) or the `poetry` command (REPL).
export const DEFAULT_POETRY_VERSION = "1.8.3";

// Environment knobs read via process.env, each falling back to the value the
// Python packaging / TLS ecosystem uses by default ("industry standard"). poetry
// itself auto-reads POETRY_* vars from the environment; we resolve them
// explicitly so the documented default still applies when the var is unset, and
// so they can be surfaced (REPL `env`) and threaded into every poetry invocation
// we build.
export const ENV_DEFAULTS = {
  POETRY_VERBOSE: "0",                                  // poetry: quiet (0 = no -v)
  POETRY_CERT: "",                                      // poetry: use certifi/system store
  POETRY_REPOSITORIES_PYPI_URL: "https://pypi.org/simple", // poetry: source URL
  POETRY_HTTP_BASIC_PYPI_USERNAME: "",                 // poetry: source auth user
  POETRY_REQUESTS_TIMEOUT: "15",                        // poetry: 15s socket timeout
  POETRY_INSTALLER_MAX_WORKERS: "5",                    // poetry: parallel installer workers
  PYTHON_REGISTRY_URL: "https://pypi.org/simple",       // our index-url fallback
  PYTHON_REGISTRY_NAME: "PyPI",                         // registry display name
  REQUESTS_CA_BUNDLE: "",                               // requests/urllib3: certifi
  SSL_CERT_FILE: "",                                    // OpenSSL: system CA file
  SSL_CERT_DIR: "",                                     // OpenSSL: system CA dir
};

// JSON metadata base used for version discovery (global fetch, no poetry call).
const PYPI_JSON_BASE = "https://pypi.org/pypi";

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

/** Pick the source URL: explicit flag > POETRY_REPOSITORIES_PYPI_URL > PYTHON_REGISTRY_URL. */
export function resolveIndexUrl(explicit, cfg = null) {
  cfg = cfg || resolveEnv();
  return explicit || cfg.POETRY_REPOSITORIES_PYPI_URL || cfg.PYTHON_REGISTRY_URL || null;
}

/** Translate resolved config into poetry command-line flags. */
export function poetryOptions(cfg) {
  const opts = [];
  let level = parseInt(cfg.POETRY_VERBOSE, 10);
  if (Number.isNaN(level)) level = 0;
  if (level > 0) opts.push("-" + "v".repeat(level)); // -v / -vv / -vvv ...
  return opts;
}

/** Child-process environment with resolved TLS cert + source vars applied. */
export function subprocessEnv(cfg, indexUrl = null) {
  const env = { ...process.env };
  for (const name of TLS_ENV_VARS) {
    if (cfg[name]) env[name] = cfg[name];
  }
  if (cfg.POETRY_CERT) env.POETRY_CERT = cfg.POETRY_CERT;
  env.POETRY_REQUESTS_TIMEOUT = String(cfg.POETRY_REQUESTS_TIMEOUT);
  // Surface the chosen source as POETRY_REPOSITORIES_PYPI_URL so poetry's own
  // env reader picks it up even when we also pass it via the project source.
  if (indexUrl) env.POETRY_REPOSITORIES_PYPI_URL = indexUrl;
  return env;
}

/**
 * Return the list of versions a registry advertises for `pkg`.
 *
 * Versions are returned newest-first. Discovery uses the PyPI JSON API
 * (`releases` keys) over the global `fetch` rather than a poetry call, since
 * poetry has no robust "list every version" command. When `verbose` is set,
 * the request URL and the raw version list are echoed so a failed or empty
 * discovery can be debugged.
 */
export async function getAvailableVersions(pkg, indexUrl, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  console.log(`Retrieving versions for '${pkg}' from ${indexUrl}...`);
  const url = `${PYPI_JSON_BASE}/${pkg}/json`;
  if (verbose) console.log(`  $ GET ${url}`);

  let data;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      parseInt(cfg.POETRY_REQUESTS_TIMEOUT, 10) * 1000,
    );
    let resp;
    try {
      resp = await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    data = await resp.json();
  } catch (e) { // network, HTTP, JSON, timeout
    console.error(`Error querying PyPI JSON API: ${e.message || e}`);
    process.exit(1);
  }

  const releases = data.releases || {};
  if (!Object.keys(releases).length) {
    console.error("Could not find 'releases' in PyPI JSON output.");
    return [];
  }
  // Sort newest-first using a tuple key so numeric segments compare naturally.
  const versions = Object.keys(releases).sort((a, b) => compareVersionKey(b, a));
  if (verbose) echo("Available versions: " + versions.join(", "));
  return versions;
}

/** Best-effort sort key: split into numeric/non-numeric tokens. */
function versionKey(version) {
  return version.split(/[.\-_+]/).map((t) => (/^\d+$/.test(t) ? parseInt(t, 10) : t));
}

/** Compare two version keys element-wise (numbers before strings, like Python). */
function compareVersionKey(a, b) {
  const ka = versionKey(a);
  const kb = versionKey(b);
  const len = Math.max(ka.length, kb.length);
  for (let i = 0; i < len; i++) {
    const x = ka[i];
    const y = kb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNum = typeof x === "number";
    const yNum = typeof y === "number";
    // Python sorts ints before strings; mirror by ranking numbers lower.
    if (xNum && !yNum) return -1;
    if (!xNum && yNum) return 1;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

/**
 * Create a fresh throwaway Poetry project if needed; return its dir.
 *
 * The sandbox is a temp project directory holding a `pyproject.toml` created
 * by `poetry init -n` (no interaction). Install-tests run `poetry add` here
 * against the pinned `poetryVersion` (default `DEFAULT_POETRY_VERSION`) so
 * they exercise a known resolver. Pass `poetryVersion=null` to keep whatever
 * poetry is on PATH. `verbose` echoes the init output so a failed scaffold
 * can be debugged.
 */
export function setupVenv(envDir, poetryVersion = DEFAULT_POETRY_VERSION, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  if (!fs.existsSync(envDir)) {
    console.log(`Creating throwaway Poetry project at: ${envDir}`);
    fs.mkdirSync(envDir, { recursive: true });
  }

  if (poetryVersion) ensurePoetryVersion(poetryVersion, cfg, verbose);

  const pyproject = path.join(envDir, "pyproject.toml");
  if (!fs.existsSync(pyproject)) {
    const cmd = ["init", "-n", "--name", "probe-project", ...poetryOptions(cfg)];
    if (verbose) console.log(`  $ (cd ${envDir} && poetry ${cmd.join(" ")})`);
    const res = spawnSync("poetry", cmd, {
      cwd: envDir, encoding: "utf8", env: subprocessEnv(cfg),
    });
    if (verbose) echo(res.stdout, res.stderr);
    if (res.status !== 0) {
      console.error(
        `Warning: could not 'poetry init': ${lastLine(res.stderr) || "unknown error"}`,
      );
    }
  }
  return envDir;
}

/** Report whether poetry on PATH matches the requested `poetryVersion`. */
function ensurePoetryVersion(poetryVersion, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  console.log(`Ensuring poetry==${poetryVersion} for the test project...`);
  const cmd = ["--version"];
  if (verbose) console.log(`  $ poetry ${cmd.join(" ")}`);
  const res = spawnSync("poetry", cmd, { encoding: "utf8", env: subprocessEnv(cfg) });
  if (verbose) echo(res.stdout, res.stderr);
  if (res.status !== 0) {
    console.error(
      `Warning: could not verify poetry==${poetryVersion}: ${lastLine(res.stderr) || "unknown error"}`,
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

/** True if poetry `options` already carry a `-v`/`-vv` flag. */
function hasVerbose(options) {
  return options.some((o) => o.startsWith("-v"));
}

/**
 * Run `cmd`, echoing combined output live while capturing it.
 *
 * Resolves to `[returncode, combinedOutput]`. Used in verbose mode so the user
 * watches poetry in real time (e.g. a slow build or a hang) yet the captured
 * text still feeds the JSON report.
 */
function stream(file, cmd, env, cwd) {
  return new Promise((resolve) => {
    const proc = spawn(file, cmd, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
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
 * Attempt to add each version; write an incremental JSON report.
 *
 * Returns the list of result objects. If `firstOnly` is set, stops after
 * the first version that installs successfully. When `verbose` is set,
 * poetry's full output is streamed live (and a `-v` flag is added if none is
 * present) so add failures can be debugged; the captured output is also folded
 * into the report under `log`/`error`.
 */
export async function testInstallations(venvDir, pkg, indexUrl, versions, outputJson, {
  firstOnly = false, cfg = null, verbose = false,
} = {}) {
  cfg = cfg || resolveEnv();
  const env = subprocessEnv(cfg, indexUrl);
  const options = poetryOptions(cfg);
  const results = [];
  const installable = [];

  for (let idx = 0; idx < versions.length; idx++) {
    const version = versions[idx];
    const target = `${pkg}==${version}`;
    console.log(`[${idx + 1}/${versions.length}] Attempting to add: ${target}...`);

    const cmd = [
      "add", target, "--lock", // resolve + lock without building a venv install tree
      ...options,
    ];
    // Bump poetry's own verbosity if the user wants detail and nothing already set it.
    if (verbose && !hasVerbose(options)) cmd.push("-v");

    let returncode, stdoutText, stderrText;
    if (verbose) {
      console.log(`  $ (cd ${venvDir} && poetry ${cmd.join(" ")})`);
      const [code, output] = await stream("poetry", cmd, env, venvDir);
      returncode = code;
      stdoutText = stderrText = output; // streamed combined; same text both ways
    } else {
      const res = spawnSync("poetry", cmd, { cwd: venvDir, encoding: "utf8", env });
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
                [--poetry-version POETRY_VERSION] [--output OUTPUT]
                [--limit LIMIT] [--first-only] [-v] package

Find installable versions of a package from a Poetry source.

positional arguments:
  package               Package name to probe (e.g. numpy).

options:
  -h, --help            show this help message and exit
  --index-url INDEX_URL
                        Custom registry simple index URL. Defaults to
                        $POETRY_REPOSITORIES_PYPI_URL, then $PYTHON_REGISTRY_URL,
                        then https://pypi.org/simple.
  --venv-dir VENV_DIR   Directory for the throwaway test Poetry project.
                        (default: .venv-test-install)
  --poetry-version POETRY_VERSION
                        poetry version expected on PATH ('none' to keep whatever
                        is installed). (default: ${DEFAULT_POETRY_VERSION})
  --output OUTPUT       Path to write the JSON report.
                        (default: installation_report.json)
  --limit LIMIT         Only test the newest N versions (default: all).
  --first-only          Stop after the first version that installs successfully.
  -v, --verbose         Stream full poetry output for every step so failures are
                        debuggable.
`;

/** Parse a `main`-style argv list into an options object (mirrors argparse). */
export function parseArgs(argv = null) {
  argv = argv === null ? process.argv.slice(2) : argv;
  const args = {
    package: null,
    indexUrl: null,
    venvDir: ".venv-test-install",
    poetryVersion: DEFAULT_POETRY_VERSION,
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
    } else if (a === "--poetry-version") {
      args.poetryVersion = next();
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
  const poetryVersion = String(args.poetryVersion).toLowerCase() === "none" ? null : args.poetryVersion;
  const venvDir = setupVenv(args.venvDir, poetryVersion, cfg, args.verbose);
  await testInstallations(venvDir, args.package, indexUrl, versions, args.output, {
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
