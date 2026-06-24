#!/usr/bin/env node
/**
 * Find metadata-valid versions of a package via twine's distribution checker.
 *
 * NOTE — repurposing twine: twine is a **publish-side** tool; its job is to upload
 * distributions to a package index, not to install or list them. This clone
 * repurposes twine as a *metadata-validity probe*. It discovers every version a
 * registry advertises via the PyPI JSON API
 * (`https://pypi.org/pypi/<pkg>/json` — the `releases` keys, sorted
 * newest-first), downloads each version's distribution with
 * `pip download <pkg>==<ver> --no-deps -d <tmp>`, then runs `twine check
 * <tmp>/*` to validate the distribution's metadata (long-description rendering,
 * PKG-INFO well-formedness). A version "passes" when `twine check` reports no
 * metadata errors. Success/failure per version is recorded to a JSON report.
 *
 * Example:
 *     node main.mjs numpy \
 *         --index-url https://my-registry.example.com/simple
 *
 *     # only probe the newest 5 versions, stop at the first that passes
 *     node main.mjs numpy --index-url https://reg/simple \
 *         --limit 5 --first-only
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// twine version the probe is pinned to by default. `twine check` behaviour
// (the metadata validators it runs) is governed by this twine, so it is the
// tool-version constant. Override via --twine-version (CLI) or the `twine`
// command (REPL).
export const DEFAULT_TWINE_VERSION = "5.1.1";

// Environment knobs read via process.env, each falling back to the value the
// Python packaging / TLS ecosystem uses by default ("industry standard"). twine
// itself auto-reads TWINE_* vars from the environment; we resolve them
// explicitly so the documented default still applies when the var is unset, and
// so they can be surfaced (REPL `env`) and threaded into every twine/pip
// invocation we build.
export const ENV_DEFAULTS = {
  TWINE_VERBOSE: "0",                                // twine: quiet (0 = no --verbose)
  TWINE_CERT: "",                                    // twine: use certifi/system store
  TWINE_REPOSITORY_URL: "https://pypi.org/simple",   // twine/pip: distribution index
  TWINE_USERNAME: "",                                // twine: index auth user
  PIP_DEFAULT_TIMEOUT: "15",                         // pip download: 15s socket timeout
  PIP_RETRIES: "5",                                  // pip download: 5 connection retries
  PYTHON_REGISTRY_URL: "https://pypi.org/simple",    // our index-url fallback
  PYTHON_REGISTRY_NAME: "PyPI",                      // registry display name
  REQUESTS_CA_BUNDLE: "",                            // requests/urllib3: certifi
  SSL_CERT_FILE: "",                                 // OpenSSL: system CA file
  SSL_CERT_DIR: "",                                  // OpenSSL: system CA dir
};

// JSON metadata base used for version discovery (global fetch, no twine call).
export const PYPI_JSON_BASE = "https://pypi.org/pypi";

// The Python interpreter we drive pip/twine through (pip download + twine check).
const PYTHON = process.env.PYTHON || "python3";

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

/** Pick the index URL: explicit flag > TWINE_REPOSITORY_URL > PYTHON_REGISTRY_URL. */
export function resolveIndexUrl(explicit, cfg = null) {
  cfg = cfg || resolveEnv();
  return explicit || cfg.TWINE_REPOSITORY_URL || cfg.PYTHON_REGISTRY_URL || null;
}

/** Translate resolved config into pip-download command-line flags. */
export function pipOptions(cfg) {
  const opts = [];
  opts.push("--timeout", String(cfg.PIP_DEFAULT_TIMEOUT));
  opts.push("--retries", String(cfg.PIP_RETRIES));
  return opts;
}

/** Translate resolved config into `twine check` command-line flags. */
export function twineOptions(cfg) {
  const opts = [];
  let level;
  const parsed = parseInt(cfg.TWINE_VERBOSE, 10);
  level = Number.isNaN(parsed) ? 0 : parsed;
  if (level > 0) opts.push("--verbose"); // twine has a single --verbose, not -v/-vv
  return opts;
}

/** Child-process environment with resolved TLS cert vars applied. */
export function subprocessEnv(cfg) {
  const env = { ...process.env };
  for (const name of TLS_ENV_VARS) {
    if (cfg[name]) env[name] = cfg[name];
  }
  if (cfg.TWINE_CERT) env.TWINE_CERT = cfg.TWINE_CERT;
  return env;
}

/**
 * Return the list of versions a registry advertises for `package`.
 *
 * Versions are returned newest-first. Discovery uses the PyPI JSON API
 * (`releases` keys) over global fetch rather than a twine call — twine
 * is publish-side and has no "list versions" command. When `verbose` is set,
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
    let timeout;
    const parsed = parseInt(cfg.PIP_DEFAULT_TIMEOUT, 10);
    timeout = Number.isNaN(parsed) ? 15 : parsed;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout * 1000);
    try {
      const resp = await fetch(url, { signal: controller.signal });
      data = JSON.parse(await resp.text());
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    console.error(`Error querying PyPI JSON API: ${e.message || e}`);
    process.exit(1);
  }

  const releases = data.releases || {};
  if (!Object.keys(releases).length) {
    console.error("Could not find 'releases' in PyPI JSON output.");
    return [];
  }
  // Sort newest-first using a tuple key so numeric segments compare naturally.
  const versions = Object.keys(releases).sort((a, b) => compareVersionKey(versionKey(b), versionKey(a)));
  if (verbose) echo("Available versions: " + versions.join(", "));
  return versions;
}

/** Best-effort sort key: split into numeric/non-numeric tokens. */
function versionKey(version) {
  return version.split(/[.\-_+]/).map((t) => (/^\d+$/.test(t) ? parseInt(t, 10) : t));
}

/** Compare two version-key arrays element-wise (numeric vs string, like Python). */
function compareVersionKey(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const av = a[i];
    const bv = b[i];
    if (av === undefined) return -1;
    if (bv === undefined) return 1;
    const aNum = typeof av === "number";
    const bNum = typeof bv === "number";
    if (aNum && bNum) {
      if (av !== bv) return av - bv;
    } else if (!aNum && !bNum) {
      if (av !== bv) return av < bv ? -1 : 1;
    } else {
      // Mirror Python's behaviour loosely: numbers sort before strings.
      return aNum ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Create a scratch download dir if needed; return its path.
 *
 * The "sandbox" here is a scratch directory into which each version's
 * distribution is downloaded (`pip download -d <envDir>/<ver>`) before
 * `twine check` validates it. `twineVersion` (default
 * `DEFAULT_TWINE_VERSION`) is the twine the probe expects on PATH; pass
 * `twineVersion=null` to keep whatever twine is installed. `verbose`
 * echoes the twine-version output so a mismatch can be debugged.
 */
export function setupVenv(envDir, twineVersion = DEFAULT_TWINE_VERSION, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  if (!fs.existsSync(envDir)) {
    console.log(`Creating scratch download dir at: ${envDir}`);
    fs.mkdirSync(envDir, { recursive: true });
  }

  if (twineVersion) ensureTwineVersion(twineVersion, cfg, verbose);
  return envDir;
}

/** Report whether twine on PATH matches the requested `twineVersion`. */
function ensureTwineVersion(twineVersion, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  console.log(`Ensuring twine==${twineVersion} for the metadata probe...`);
  const cmd = ["-m", "twine", "--version"];
  if (verbose) console.log(`  $ ${PYTHON} ${cmd.join(" ")}`);
  const res = spawnSync(PYTHON, cmd, {
    encoding: "utf8",
    env: subprocessEnv(cfg),
    maxBuffer: 50 * 1024 * 1024, // defensive guard against future verbose output
  });
  if (verbose) echo(res.stdout, res.stderr);
  if (res.status !== 0) {
    // status is null when the child was killed by a signal (stderr empty in that
    // case) — fall back to the signal name so the warning isn't reported blank.
    const detail = lastLine(res.stderr)
      || (res.signal && `terminated by signal ${res.signal}`)
      || (res.error && res.error.message)
      || "unknown error";
    console.error(
      `Warning: could not verify twine==${twineVersion}: ${detail}`,
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

/** True if twine `options` already carry a `--verbose` flag. */
function hasVerbose(options) {
  return options.some((o) => o === "--verbose");
}

/**
 * Run `python <cmd>`, echoing combined output live while capturing it.
 *
 * Resolves to `[returncode, combinedOutput]`. Used in verbose mode so the user
 * watches pip/twine in real time (e.g. a slow download or a hang) yet the
 * captured text still feeds the JSON report.
 */
function stream(cmd, env) {
  return new Promise((resolve) => {
    const proc = spawn(PYTHON, cmd, { env, stdio: ["ignore", "pipe", "pipe"] });
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
 * Download + `twine check` each version; write an incremental JSON report.
 *
 * For each version we first `pip download <pkg>==<ver> --no-deps` into a
 * per-version subdir, then `twine check` the downloaded distributions and
 * classify success on twine's returncode (no metadata errors). Returns the
 * list of result objects. If `firstOnly` is set, stops after the first
 * version that passes. When `verbose` is set, full output is streamed live
 * (and a `--verbose` flag is added to twine if none is present) so failures
 * can be debugged; the captured output is also folded into the report under
 * `log`/`error`.
 */
export async function testInstallations(scratchDir, pkg, indexUrl, versions, outputJson, {
  firstOnly = false, cfg = null, verbose = false,
} = {}) {
  cfg = cfg || resolveEnv();
  const env = subprocessEnv(cfg);
  const twineOpts = twineOptions(cfg);
  const pipOpts = pipOptions(cfg);
  const results = [];
  const installable = [];

  for (let idx = 0; idx < versions.length; idx++) {
    const version = versions[idx];
    const target = `${pkg}==${version}`;
    console.log(`[${idx + 1}/${versions.length}] Validating metadata for: ${target}...`);

    const dlDir = path.join(scratchDir, version);
    fs.mkdirSync(dlDir, { recursive: true });

    // Step 1: download the distribution (no deps) into the per-version dir.
    const dlCmd = [
      "-m", "pip", "download", target, "--no-deps", "-d", dlDir, "--no-cache-dir",
      ...pipOpts,
    ];
    if (indexUrl) dlCmd.push("--index-url", indexUrl);

    let dlRc, dlStdout, dlStderr;
    if (verbose) {
      console.log(`  $ ${PYTHON} ${dlCmd.join(" ")}`);
      const [code, output] = await stream(dlCmd, env);
      dlRc = code;
      dlStdout = dlStderr = output;
    } else {
      const dlRes = spawnSync(PYTHON, dlCmd, {
        encoding: "utf8",
        env,
        maxBuffer: 50 * 1024 * 1024, // defensive guard against future verbose output
      });
      dlRc = dlRes.status;
      dlStdout = dlRes.stdout;
      dlStderr = dlRes.stderr;
    }

    if (dlRc !== 0) {
      console.log(`  ❌ FAILED: ${target}`);
      results.push({ version, status: "failed", error: lastLine(dlStderr) || "download failed" });
      persist(results, outputJson);
      continue;
    }

    // Step 2: twine check the downloaded distributions (metadata validity).
    const dists = fs.readdirSync(dlDir).map((f) => path.join(dlDir, f)).sort();
    const checkCmd = ["-m", "twine", "check", ...dists, ...twineOpts];
    // Bump twine's own verbosity if the user wants detail and nothing already set it.
    if (verbose && !hasVerbose(twineOpts)) checkCmd.push("--verbose");

    let returncode, stdoutText, stderrText;
    if (verbose) {
      console.log(`  $ ${PYTHON} ${checkCmd.join(" ")}`);
      const [code, output] = await stream(checkCmd, env);
      returncode = code;
      stdoutText = stderrText = output; // streamed combined; same text both ways
    } else {
      const res = spawnSync(PYTHON, checkCmd, {
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
      results.push({
        version,
        status: "failed",
        error: lastLine(stderrText) || lastLine(stdoutText) || "Unknown error",
      });
    }

    // Persist after every iteration so partial results survive a crash.
    persist(results, outputJson);

    if (firstOnly && installable.length) {
      console.log(`  First metadata-valid version found: ${installable[0]} (stopping).`);
      break;
    }
  }

  console.log(`\nTesting complete! Results saved to ${outputJson}`);
  if (installable.length) {
    console.log(`Metadata-valid versions (${installable.length}): ${installable.join(", ")}`);
  } else {
    console.log("No metadata-valid versions found.");
  }
  return results;
}

/** Rewrite the full JSON report (crash-safe incremental persistence). */
function persist(results, outputJson) {
  fs.writeFileSync(outputJson, JSON.stringify(results, null, 4));
}

const HELP = `usage: main.mjs [-h] [--index-url INDEX_URL] [--venv-dir VENV_DIR]
                [--twine-version TWINE_VERSION] [--output OUTPUT] [--limit LIMIT]
                [--first-only] [-v] package

Find metadata-valid versions of a package via twine check.

positional arguments:
  package               Package name to probe (e.g. numpy).

options:
  -h, --help            show this help message and exit
  --index-url, --repository-url INDEX_URL
                        Custom registry simple index URL (pip download source).
                        Defaults to $TWINE_REPOSITORY_URL, then $PYTHON_REGISTRY_URL,
                        then https://pypi.org/simple.
  --venv-dir VENV_DIR   Directory for the scratch per-version download dirs.
                        (default: .venv-test-install)
  --twine-version TWINE_VERSION
                        twine version expected on PATH ('none' to keep whatever is
                        installed). (default: ${DEFAULT_TWINE_VERSION})
  --output OUTPUT       Path to write the JSON report.
                        (default: installation_report.json)
  --limit LIMIT         Only test the newest N versions (default: all).
  --first-only          Stop after the first version whose metadata validates.
  -v, --verbose         Stream full pip/twine output for every step so failures are
                        debuggable.
`;

/** Parse a `main`-style argv list into an options object (mirrors argparse). */
export function parseArgs(argv = null) {
  argv = argv === null ? process.argv.slice(2) : argv;
  const args = {
    package: null,
    indexUrl: null,
    venvDir: ".venv-test-install",
    twineVersion: DEFAULT_TWINE_VERSION,
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
    } else if (a === "--index-url" || a === "--repository-url") {
      args.indexUrl = next();
    } else if (a === "--venv-dir") {
      args.venvDir = next();
    } else if (a === "--twine-version") {
      args.twineVersion = next();
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
  const twineVersion = String(args.twineVersion).toLowerCase() === "none" ? null : args.twineVersion;
  const scratchDir = setupVenv(args.venvDir, twineVersion, cfg, args.verbose);
  await testInstallations(scratchDir, args.package, indexUrl, versions, args.output, {
    firstOnly: args.firstOnly, cfg, verbose: args.verbose,
  });
  return 0;
}

// main() accepts an optional argv list. Pass one explicitly to drive the tool
// programmatically (e.g. from another script or a test); omit it and main()
// falls back to parseArgs(null), which reads from process.argv (normal CLI use).
//
// Example — probe the newest 5 versions of numpy, stop at the first that passes:
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
