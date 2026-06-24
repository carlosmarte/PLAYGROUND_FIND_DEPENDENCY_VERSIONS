#!/usr/bin/env node
/**
 * Find installable versions of a package from a (custom) Hackage registry.
 *
 * Discovers every version Hackage advertises for a package via its HTTP JSON
 * endpoint (`https://hackage.haskell.org/package/<pkg>.json`, a
 * version->preference map), then attempts to fetch each one into an isolated
 * scratch directory with `cabal get`, recording success/failure per version to
 * a JSON report.
 *
 * Example:
 *     node main.mjs aeson \
 *         --index-url https://hackage.haskell.org
 *
 *     # only probe the newest 5 versions, stop at the first that fetches
 *     node main.mjs aeson --index-url https://hackage.haskell.org \
 *         --limit 5 --first-only
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// cabal tool version the test environment expects by default. Fetch-tests run
// against this cabal, so it governs resolver/fetch behaviour. Override via
// --cabal-version (CLI) or the `cabal` command (REPL). cabal is not pinnable the
// way pip is, so this is advisory: we surface it and warn on a mismatch.
export const DEFAULT_CABAL_VERSION = "3.12.1.0";

// Environment knobs read via process.env, each falling back to the value the
// Haskell / cabal / TLS ecosystem uses by default ("industry standard"). cabal
// reads a handful of vars from the environment; we resolve them explicitly so
// the documented default still applies when the var is unset, and so they can be
// surfaced (REPL `env`) and threaded into every cabal invocation we build.
export const ENV_DEFAULTS = {
  CABAL_VERBOSE: "0",                            // cabal: quiet (0 = -v0)
  CABAL_CERT: "",                                // cabal: use system CA store
  HACKAGE_API_URL: "https://hackage.haskell.org",  // Hackage JSON/page base
  CABAL_REMOTE_REPO: "https://hackage.haskell.org",  // cabal: remote-repo URL
  CABAL_INSECURE: "0",                            // cabal: keep TLS verification
  CABAL_HTTP_TIMEOUT: "15",                      // advisory: 15s socket timeout
  CABAL_HTTP_RETRIES: "5",                       // advisory: fetch retries
  CABAL_REGISTRY_URL: "https://hackage.haskell.org",  // our index-url fallback
  CABAL_REGISTRY_NAME: "Hackage",               // registry display name
  REQUESTS_CA_BUNDLE: "",                        // urllib: certifi CA bundle
  SSL_CERT_FILE: "",                             // OpenSSL: system CA file
  SSL_CERT_DIR: "",                             // OpenSSL: system CA dir
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

/** Pick the index URL: explicit flag > CABAL_REGISTRY_URL > HACKAGE_API_URL. */
export function resolveIndexUrl(explicit, cfg = null) {
  cfg = cfg || resolveEnv();
  return explicit || cfg.CABAL_REGISTRY_URL || cfg.HACKAGE_API_URL || null;
}

/** Translate resolved config into cabal command-line flags. */
export function cabalOptions(cfg) {
  const opts = [];
  let level = parseInt(cfg.CABAL_VERBOSE, 10);
  if (Number.isNaN(level)) level = 0;
  if (level > 0) opts.push("-v" + String(level)); // cabal: -v1 / -v2 / -v3 verbosity
  return opts;
}

/** Child-process environment with resolved cabal/TLS vars applied. */
export function subprocessEnv(cfg) {
  const env = { ...process.env };
  for (const name of TLS_ENV_VARS) {
    if (cfg[name]) env[name] = cfg[name];
  }
  if (cfg.CABAL_CERT) env.SSL_CERT_FILE = cfg.CABAL_CERT;
  return env;
}

/** Derive the Hackage base URL from the index URL or HACKAGE_API_URL. */
function apiBase(indexUrl, cfg) {
  if (indexUrl) return indexUrl.replace(/\/+$/, "");
  return cfg.HACKAGE_API_URL.replace(/\/+$/, "");
}

/**
 * Return the list of versions Hackage advertises for `package`.
 *
 * Primary source is Hackage's JSON endpoint (`/package/<pkg>.json`), a
 * `{version: preference}` map. We sort the keys descending by their numeric
 * components so the list comes back newest-first. When `verbose` is set, the
 * URL and raw output are echoed so a failed or empty discovery can be
 * debugged.
 */
export async function getAvailableVersions(pkg, indexUrl, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  console.log(`Retrieving versions for '${pkg}' from ${indexUrl}...`);
  const base = apiBase(indexUrl, cfg);
  const url = `${base}/package/${pkg}.json`;
  if (verbose) console.log(`  $ GET ${url}`);

  let payload;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      parseInt(cfg.CABAL_HTTP_TIMEOUT, 10) * 1000,
    );
    try {
      const resp = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      payload = await resp.text();
    } finally {
      clearTimeout(timeout);
    }
  } catch (e) {
    console.error(`Error querying Hackage: ${e}`);
    return [];
  }

  if (verbose) echo(payload);
  let versions;
  try {
    const data = JSON.parse(payload);
    // The JSON endpoint is a {version: "normal"/"unpreferred"/...} map; the
    // keys are the versions. Sort newest-first by numeric version tuple.
    versions = Object.keys(data).sort((a, b) => cmpVersionKey(versionKey(a), versionKey(b))).reverse();
  } catch (e) {
    console.error(`Could not parse Hackage JSON: ${e}`);
    return [];
  }
  if (!versions.length) {
    console.error("No versions in Hackage response.");
  }
  return versions;
}

/** Return a sortable tuple of numeric components for a version string. */
function versionKey(ver) {
  return ver.split(/[.\-]/).map((p) => (/^\d+$/.test(p) ? parseInt(p, 10) : 0));
}

/** Compare two version-key tuples lexicographically (ascending). */
function cmpVersionKey(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/**
 * Create a fresh scratch fetch directory if needed; return its path.
 *
 * cabal has no per-project virtualenv: the isolated sandbox is a throwaway
 * directory each `cabal get` unpacks into. The directory is created lazily
 * and reused. `cabalVersion` is advisory (cabal is not pinnable like pip);
 * pass `cabalVersion=null` to skip the version check. `verbose` echoes
 * the version probe so a mismatch can be debugged.
 */
export function setupVenv(envDir, cabalVersion = DEFAULT_CABAL_VERSION, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  if (!fs.existsSync(envDir)) {
    console.log(`Creating fetch sandbox at: ${envDir}`);
    fs.mkdirSync(envDir, { recursive: true });
  }

  if (cabalVersion) ensureCabalVersion(cabalVersion, cfg, verbose);
  // The "handle" the test step needs is just the sandbox directory.
  return envDir;
}

/** Check the installed cabal against `cabalVersion` (advisory only). */
function ensureCabalVersion(cabalVersion, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  console.log(`Ensuring cabal==${cabalVersion} in the test environment...`);
  const cmd = ["--version"];
  if (verbose) console.log(`  $ cabal ${cmd.join(" ")}`);
  const res = spawnSync("cabal", cmd, {
    encoding: "utf8",
    env: subprocessEnv(cfg),
    maxBuffer: 50 * 1024 * 1024, // defensive guard against future verbose output
  });
  if (verbose) echo(res.stdout, res.stderr);
  if (res.status !== 0) {
    // status is null when the child was killed by a signal — stderr is empty in
    // that case, so fall back to the signal name / spawn error.
    const detail = lastLine(res.stderr)
      || (res.signal && `terminated by signal ${res.signal}`)
      || (res.error && res.error.message)
      || "cabal not found";
    console.error(
      `Warning: could not verify cabal==${cabalVersion}: ${detail}`,
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

/** True if cabal `options` already carry a `-v`/`-v2` flag. */
function hasVerbose(options) {
  return options.some((o) => o.startsWith("-v"));
}

/**
 * Run `cabal <cmd>`, echoing combined output live while capturing it.
 *
 * Resolves to `{ status, output }`. Used in verbose mode so the user watches
 * cabal in real time (e.g. a slow fetch or a hang) yet the captured text still
 * feeds the JSON report.
 */
function stream(cmd, env) {
  return new Promise((resolve) => {
    const proc = spawn("cabal", cmd, { env, stdio: ["ignore", "pipe", "pipe"] });
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
 * Attempt to fetch each version; write an incremental JSON report.
 *
 * Returns the list of result objects. If `firstOnly` is set, stops after the
 * first version that fetches successfully. When `verbose` is set, cabal's
 * full output is streamed live (and a `-v2` flag is added if none is
 * present) so fetch failures can be debugged; the captured output is also
 * folded into the report under `log`/`error`.
 */
export async function testInstallations(envDir, pkg, indexUrl, versions, outputJson, {
  firstOnly = false, cfg = null, verbose = false,
} = {}) {
  cfg = cfg || resolveEnv();
  const env = subprocessEnv(cfg);
  const options = cabalOptions(cfg);
  const results = [];
  const installable = [];

  for (let idx = 0; idx < versions.length; idx++) {
    const version = versions[idx];
    const target = `${pkg}-${version}`;
    console.log(`[${idx + 1}/${versions.length}] Attempting to fetch: ${target}...`);

    // Each fetch unpacks into its own subdir of the sandbox so versions
    // never clobber one another and the sandbox stays inspectable.
    const dest = path.join(envDir, target);
    let cmd = ["get", target, "-d", dest];
    cmd = cmd.concat(options);
    // Bump cabal's own verbosity if the user wants detail and nothing set it.
    if (verbose && !hasVerbose(options)) cmd.push("-v2");

    let returncode, stdoutText, stderrText;
    if (verbose) {
      console.log(`  $ cabal ${cmd.join(" ")}`);
      const [code, output] = await stream(cmd, env);
      returncode = code;
      stdoutText = stderrText = output; // streamed combined; same text both ways
    } else {
      const res = spawnSync("cabal", cmd, {
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

const HELP = `usage: main.mjs [-h] [--index-url INDEX_URL] [--venv-dir VENV_DIR]
                [--cabal-version CABAL_VERSION] [--output OUTPUT] [--limit LIMIT]
                [--first-only] [-v] package

Find installable versions of a package from a Hackage registry.

positional arguments:
  package               Package name to probe (e.g. aeson).

options:
  -h, --help            show this help message and exit
  --index-url INDEX_URL
                        Custom Hackage registry URL. Defaults to $CABAL_REGISTRY_URL,
                        then $HACKAGE_API_URL, then https://hackage.haskell.org.
  --venv-dir VENV_DIR   Directory for the isolated fetch sandbox.
                        (default: .cabal-test-fetch)
  --cabal-version CABAL_VERSION
                        cabal version expected in the test sandbox ('none' to skip the
                        check). (default: ${DEFAULT_CABAL_VERSION})
  --output OUTPUT       Path to write the JSON report.
                        (default: installation_report.json)
  --limit LIMIT         Only test the newest N versions (default: all).
  --first-only          Stop after the first version that fetches successfully.
  -v, --verbose         Stream full cabal output for every step so failures are
                        debuggable.
`;

/** Parse a `main`-style argv list into an options object (mirrors argparse). */
export function parseArgs(argv = null) {
  argv = argv === null ? process.argv.slice(2) : argv;
  const args = {
    package: null,
    indexUrl: null,
    venvDir: ".cabal-test-fetch",
    cabalVersion: DEFAULT_CABAL_VERSION,
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
    } else if (a === "--cabal-version") {
      args.cabalVersion = next();
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

  console.log(`Found ${versions.length} version(s) to test (registry: ${cfg.CABAL_REGISTRY_NAME}).`);
  const cabalVersion = String(args.cabalVersion).toLowerCase() === "none" ? null : args.cabalVersion;
  const envDir = setupVenv(args.venvDir, cabalVersion, cfg, args.verbose);
  await testInstallations(envDir, args.package, indexUrl, versions, args.output, {
    firstOnly: args.firstOnly, cfg, verbose: args.verbose,
  });
  return 0;
}

// main() accepts an optional argv list. Pass one explicitly to drive the tool
// programmatically (e.g. from another script or a test); omit it and main()
// falls back to parseArgs(null), which reads from process.argv (normal CLI use).
//
// Example — probe the newest 5 versions of aeson, stop at the first fetchable:
//     main(["aeson", "--index-url", "https://hackage.haskell.org",
//           "--limit", "5", "--first-only"])
//
// Equivalent on the command line:
//     node main.mjs aeson \
//         --index-url https://hackage.haskell.org --limit 5 --first-only

import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then((code) => process.exit(code)); // argv=null -> parseArgs reads process.argv
}
