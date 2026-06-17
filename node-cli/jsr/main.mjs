#!/usr/bin/env node
/**
 * Find installable versions of a package from the JSR registry.
 *
 * Discovers every version JSR advertises for a `@scope/name` package via the
 * registry's HTTP JSON metadata (`https://jsr.io/@<scope>/<name>/meta.json`),
 * then attempts to add each one into an isolated temp project with
 * `npx jsr add`, recording success/failure per version to a JSON report.
 *
 * Example:
 *     node main.mjs @std/encoding \
 *         --registry https://jsr.io
 *
 *     # only probe the newest 5 versions, stop at the first that installs
 *     node main.mjs @std/encoding --registry https://jsr.io \
 *         --limit 5 --first-only
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// jsr/deno toolchain version the test environment is pinned to by default.
// Install-tests run via `npx jsr add`, which doesn't take a pinned jsr version
// the way pip pins pip, so this is informational ("none" keeps whatever is on
// PATH). Override via --jsr-version (CLI) or the `jsr` command (REPL).
export const DEFAULT_JSR_VERSION = "none";

// Environment knobs read via process.env, each falling back to the value the
// JSR / Node.js / TLS ecosystem uses by default ("industry standard"). The JSR
// registry is HTTP-only for discovery; `npx jsr add` reads NPM_CONFIG_* like
// npm. We resolve them explicitly so the documented default still applies when
// the var is unset, surface them (REPL `env`), and thread them into invocations.
export const ENV_DEFAULTS = {
  NPM_CONFIG_LOGLEVEL: "warn",                   // npx/jsr: log level (warn = quiet)
  NPM_CONFIG_CAFILE: "",                          // npx: use bundled/system CA store
  JSR_URL: "https://jsr.io",                      // jsr: registry base URL
  NPM_CONFIG_STRICT_SSL: "true",                  // npx: verify TLS certificates
  JSR_FETCH_TIMEOUT: "30",                        // our HTTP discovery timeout (s)
  JSR_FETCH_RETRIES: "2",                         // our HTTP discovery retries
  JSR_REGISTRY_URL: "https://jsr.io",             // our registry fallback
  JSR_REGISTRY_NAME: "JSR",                       // registry display name
  NODE_EXTRA_CA_CERTS: "",                        // node: extra CA bundle
  SSL_CERT_FILE: "",                              // OpenSSL: system CA file
  SSL_CERT_DIR: "",                               // OpenSSL: system CA dir
};

// TLS vars passed through to child processes via the environment (no CLI flag).
const TLS_ENV_VARS = ["NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR"];

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

/** Pick the registry URL: explicit flag > JSR_URL > JSR_REGISTRY_URL. */
export function resolveIndexUrl(explicit, cfg = null) {
  cfg = cfg || resolveEnv();
  return explicit || cfg.JSR_URL || cfg.JSR_REGISTRY_URL || null;
}

/** Translate resolved config into `npx jsr add` command-line flags. */
export function jsrOptions(cfg) {
  const opts = [];
  const level = (cfg.NPM_CONFIG_LOGLEVEL || "").trim();
  if (level) opts.push("--loglevel", level);
  if (cfg.NPM_CONFIG_CAFILE) opts.push("--cafile", cfg.NPM_CONFIG_CAFILE);
  if (["false", "0", "no"].includes(String(cfg.NPM_CONFIG_STRICT_SSL).toLowerCase())) {
    opts.push("--strict-ssl", "false");
  }
  return opts;
}

/** Child-process environment with resolved TLS cert vars applied. */
export function subprocessEnv(cfg) {
  const env = { ...process.env };
  for (const name of TLS_ENV_VARS) {
    if (cfg[name]) env[name] = cfg[name];
  }
  if (cfg.NPM_CONFIG_CAFILE) env.NPM_CONFIG_CAFILE = cfg.NPM_CONFIG_CAFILE;
  return env;
}

/**
 * Split a `@scope/name` package into `[scope, name]` for URL building.
 *
 * JSR packages are always scoped. A leading `@` is optional in user input;
 * we normalise it away for the URL path.
 */
function splitScopeName(pkg) {
  const stripped = pkg.replace(/^@+/, "");
  if (!stripped.includes("/")) {
    throw new Error(`JSR package must be '@scope/name', got '${pkg}'`);
  }
  const idx = stripped.indexOf("/");
  const scope = stripped.slice(0, idx);
  const name = stripped.slice(idx + 1);
  return [scope, name];
}

/**
 * Return the list of versions JSR advertises for `package`.
 *
 * JSR has no "list versions" CLI; instead we GET the registry's JSON metadata
 * at `<registry>/@<scope>/<name>/meta.json` (global fetch) and read the keys of
 * its `versions` object. Versions are returned newest-first (sorted
 * descending). When `verbose` is set, the request URL and raw payload are
 * echoed so a failed or empty discovery can be debugged.
 */
export async function getAvailableVersions(pkg, indexUrl, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  const base = (indexUrl || cfg.JSR_REGISTRY_URL).replace(/\/+$/, "");
  let scope, name;
  try {
    [scope, name] = splitScopeName(pkg);
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
  const metaUrl = `${base}/@${scope}/${name}/meta.json`;
  console.log(`Retrieving versions for '${pkg}' from ${base}...`);
  if (verbose) console.log(`  $ GET ${metaUrl}`);

  const payload = await httpGetJson(metaUrl, cfg, verbose);
  if (payload === null) process.exit(1);
  if (verbose) echo(JSON.stringify(payload));
  const versionsMap = payload.versions;
  if (typeof versionsMap !== "object" || versionsMap === null || Array.isArray(versionsMap)) {
    console.error("Could not find a 'versions' object in JSR meta.json.");
    return [];
  }
  // Drop yanked versions, then sort newest-first by semver-ish version key.
  const live = Object.entries(versionsMap)
    .filter(([, meta]) => !(meta && typeof meta === "object" && meta.yanked))
    .map(([v]) => v);
  return live.sort((a, b) => compareVersionKey(b, a));
}

/**
 * Comparable key turning a version string into a tuple-like array.
 *
 * Numeric dotted segments compare numerically; a trailing pre-release suffix
 * (after `-`) is kept as text so `1.2.0` sorts above `1.2.0-rc.1`.
 */
function versionKey(version) {
  const dash = version.indexOf("-");
  const core = dash === -1 ? version : version.slice(0, dash);
  const pre = dash === -1 ? "" : version.slice(dash + 1);
  const nums = core.split(".").map((p) => (/^\d+$/.test(p) ? parseInt(p, 10) : 0));
  // A release (no pre) ranks above any pre-release of the same core.
  return { nums, isRelease: pre === "", pre };
}

/** Compare two version strings; mirrors Python's tuple ordering of _version_key. */
function compareVersionKey(a, b) {
  const ka = versionKey(a);
  const kb = versionKey(b);
  const len = Math.max(ka.nums.length, kb.nums.length);
  for (let i = 0; i < len; i++) {
    const na = ka.nums[i] ?? 0;
    const nb = kb.nums[i] ?? 0;
    if (na !== nb) return na - nb;
  }
  if (ka.isRelease !== kb.isRelease) return ka.isRelease ? 1 : -1;
  if (ka.pre < kb.pre) return -1;
  if (ka.pre > kb.pre) return 1;
  return 0;
}

/** GET `url` and parse JSON, retrying per JSR_FETCH_RETRIES. Returns object or null. */
async function httpGetJson(url, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  let timeout = parseFloat(cfg.JSR_FETCH_TIMEOUT);
  if (Number.isNaN(timeout)) timeout = 30.0;
  let retries = parseInt(cfg.JSR_FETCH_RETRIES, 10);
  if (Number.isNaN(retries)) retries = 2;
  let lastErr = "";
  for (let attempt = 0; attempt < retries + 1; attempt++) {
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), timeout * 1000);
      let res;
      try {
        res = await fetch(url, { headers: { Accept: "application/json" }, signal: ac.signal });
      } finally {
        clearTimeout(t);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      return JSON.parse(text);
    } catch (e) {
      lastErr = e.message || String(e);
      if (verbose) echo(`  attempt ${attempt + 1} failed: ${lastErr}`);
    }
  }
  console.error(`Error fetching ${url}: ${lastErr || "unknown error"}`);
  return null;
}

/**
 * Create a fresh temp project dir if needed; return its directory path.
 *
 * JSR installs land in a Node-style project via `npx jsr add`. We pin the tool
 * concept to `jsrVersion` (default `DEFAULT_JSR_VERSION` = "none"), which is
 * informational here: JSR's CLI isn't versioned the way pip is, so "none" keeps
 * whatever jsr/deno is on PATH. `verbose` echoes the setup.
 */
export function setupVenv(envDir, jsrVersion = DEFAULT_JSR_VERSION, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  if (!fs.existsSync(envDir)) {
    console.log(`Creating temp project at: ${envDir}`);
    fs.mkdirSync(envDir, { recursive: true });
  }
  // A minimal package.json keeps npx/jsr from walking up to a parent project.
  const pkgJson = path.join(envDir, "package.json");
  if (!fs.existsSync(pkgJson)) {
    fs.writeFileSync(pkgJson, JSON.stringify({ name: "jsr-versions-sandbox", private: true }));
  }

  if (jsrVersion && String(jsrVersion).toLowerCase() !== "none") {
    ensureJsrVersion(envDir, jsrVersion, cfg, verbose);
  }
  return envDir;
}

/**
 * Record the requested jsr/deno toolchain version for the sandbox.
 *
 * JSR's `npx jsr` CLI isn't pinned the way pip pins pip, so this is a
 * best-effort note rather than a hard install. We stash it under `jsrVersion`
 * so the intent is visible in the temp project.
 */
function ensureJsrVersion(envDir, jsrVersion, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  console.log(`Ensuring jsr==${jsrVersion} in the test environment...`);
  const pkgJson = path.join(envDir, "package.json");
  try {
    const data = JSON.parse(fs.readFileSync(pkgJson, "utf8"));
    data.jsrVersion = String(jsrVersion);
    fs.writeFileSync(pkgJson, JSON.stringify(data));
    if (verbose) echo(`recorded jsrVersion = ${jsrVersion} in ${pkgJson}`);
  } catch (e) {
    console.error(`Warning: could not pin jsr==${jsrVersion}: ${e.message}`);
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

/** True if `npx jsr` `options` already carry a verbose loglevel flag. */
function hasVerbose(options) {
  for (let i = 0; i < options.length; i++) {
    if (
      options[i] === "--loglevel" &&
      i + 1 < options.length &&
      ["verbose", "silly", "info", "debug"].includes(options[i + 1])
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Run `cmd`, echoing combined output live while capturing it.
 *
 * Resolves to `[returncode, combinedOutput]`. Used in verbose mode so the user
 * watches `npx jsr` in real time (e.g. a slow build or a hang) yet the captured
 * text still feeds the JSON report.
 */
function stream(cmd, env, cwd = undefined) {
  return new Promise((resolve) => {
    const proc = spawn(cmd[0], cmd.slice(1), { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
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
 * Attempt to add each version via `npx jsr add`; write an incremental report.
 *
 * `pipPath` is the temp project directory returned by `setupVenv`. Returns the
 * list of result objects. If `firstOnly` is set, stops after the first version
 * that installs successfully. When `verbose` is set, `npx jsr`'s full output is
 * streamed live (and a `--loglevel verbose` flag is added if none is present)
 * so install failures can be debugged; the captured output is also folded into
 * the report under `log`/`error`.
 */
export async function testInstallations(pipPath, pkg, indexUrl, versions, outputJson, {
  firstOnly = false, cfg = null, verbose = false,
} = {}) {
  cfg = cfg || resolveEnv();
  const env = subprocessEnv(cfg);
  // JSR_URL points npx/jsr at a custom registry mirror when set.
  if (indexUrl) env.JSR_URL = indexUrl;
  const options = jsrOptions(cfg);
  const results = [];
  const installable = [];
  const [scope, name] = splitScopeName(pkg);

  for (let idx = 0; idx < versions.length; idx++) {
    const version = versions[idx];
    const target = `@${scope}/${name}@${version}`;
    console.log(`[${idx + 1}/${versions.length}] Attempting to install: ${target}...`);

    const cmd = [
      "npx",
      "jsr",
      "add",
      target,
      ...options,
    ];
    // Bump verbosity if the user wants detail and nothing already set it.
    if (verbose && !hasVerbose(options)) cmd.push("--loglevel", "verbose");

    let returncode, stdoutText, stderrText;
    if (verbose) {
      console.log(`  $ ${cmd.join(" ")}`);
      const [code, output] = await stream(cmd, env, pipPath);
      returncode = code;
      stdoutText = stderrText = output; // streamed combined; same text both ways
    } else {
      const res = spawnSync(cmd[0], cmd.slice(1), { encoding: "utf8", env, cwd: pipPath });
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

const HELP = `usage: main.mjs [-h] [--registry INDEX_URL] [--venv-dir VENV_DIR]
                [--jsr-version JSR_VERSION] [--output OUTPUT] [--limit LIMIT]
                [--first-only] [-v] package

Find installable versions of a package from the JSR registry.

positional arguments:
  package               Scoped package to probe (e.g. @std/encoding).

options:
  -h, --help            show this help message and exit
  --registry, --index-url INDEX_URL
                        Custom JSR registry URL. Defaults to $JSR_URL,
                        then $JSR_REGISTRY_URL, then https://jsr.io.
  --venv-dir VENV_DIR   Directory for the isolated test temp project.
                        (default: .jsr-test-install)
  --jsr-version JSR_VERSION
                        jsr/deno toolchain version to record for the test project
                        ('none' to keep PATH). (default: ${DEFAULT_JSR_VERSION})
  --output OUTPUT       Path to write the JSON report.
                        (default: installation_report.json)
  --limit LIMIT         Only test the newest N versions (default: all).
  --first-only          Stop after the first version that installs successfully.
  -v, --verbose         Stream full npx jsr output for every step so failures are
                        debuggable.
`;

/** Parse a `main`-style argv list into an options object (mirrors argparse). */
export function parseArgs(argv = null) {
  argv = argv === null ? process.argv.slice(2) : argv;
  const args = {
    package: null,
    indexUrl: null,
    venvDir: ".jsr-test-install",
    jsrVersion: DEFAULT_JSR_VERSION,
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
    } else if (a === "--registry" || a === "--index-url") {
      args.indexUrl = next();
    } else if (a === "--venv-dir") {
      args.venvDir = next();
    } else if (a === "--jsr-version") {
      args.jsrVersion = next();
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

  console.log(`Found ${versions.length} version(s) to test (registry: ${cfg.JSR_REGISTRY_NAME}).`);
  const jsrVersion = String(args.jsrVersion).toLowerCase() === "none" ? null : args.jsrVersion;
  const pipPath = setupVenv(args.venvDir, jsrVersion, cfg, args.verbose);
  await testInstallations(pipPath, args.package, indexUrl, versions, args.output, {
    firstOnly: args.firstOnly, cfg, verbose: args.verbose,
  });
  return 0;
}

// main() accepts an optional argv list. Pass one explicitly to drive the tool
// programmatically (e.g. from another script or a test); omit it and main()
// falls back to parseArgs(null), which reads from process.argv (normal CLI use).
//
// Example — probe the newest 5 versions of @std/encoding, stop at the first installable:
//     main(["@std/encoding", "--registry", "https://jsr.io",
//           "--limit", "5", "--first-only"])
//
// Equivalent on the command line:
//     node main.mjs @std/encoding \
//         --registry https://jsr.io --limit 5 --first-only

import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then((code) => process.exit(code)); // argv=null -> parseArgs reads process.argv
}
