#!/usr/bin/env node
/**
 * Find installable versions of a package from a (custom) npm registry.
 *
 * Discovers every version a registry advertises for a package via
 * `npm view <pkg> versions --json`, then attempts to install each one in an
 * isolated install prefix, recording success/failure per version to a JSON
 * report.
 *
 * Example:
 *     node main.mjs left-pad \
 *         --registry https://my-registry.example.com
 *
 *     # only probe the newest 5 versions, stop at the first that installs
 *     node main.mjs left-pad --registry https://reg \
 *         --limit 5 --first-only
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// npm version the test environment is pinned to by default. Install-tests run
// against this npm, so it governs resolver/lockfile behaviour. Override via
// --npm-version (CLI) or the `npm` command (REPL).
export const DEFAULT_NPM_VERSION = "10.9.2";

// Environment knobs read via process.env, each falling back to the value the
// Node.js / npm / TLS ecosystem uses by default ("industry standard"). npm
// itself auto-reads NPM_CONFIG_* vars from the environment; we resolve them
// explicitly so the documented default still applies when the var is unset, and
// so they can be surfaced (REPL `env`) and threaded into every npm invocation.
export const ENV_DEFAULTS = {
  NPM_CONFIG_LOGLEVEL: "warn",                      // npm: log level (warn = quiet)
  NPM_CONFIG_CAFILE: "",                            // npm: use bundled/system CA store
  NPM_CONFIG_REGISTRY: "https://registry.npmjs.org", // npm: package registry
  NPM_CONFIG_STRICT_SSL: "true",                    // npm: verify TLS certificates
  NPM_CONFIG_FETCH_TIMEOUT: "300000",               // npm: 300s fetch timeout (ms)
  NPM_CONFIG_FETCH_RETRIES: "2",                    // npm: 2 fetch retries
  NODE_REGISTRY_URL: "https://registry.npmjs.org",  // our registry fallback
  NODE_REGISTRY_NAME: "npm",                        // registry display name
  NODE_EXTRA_CA_CERTS: "",                          // node: extra CA bundle
  SSL_CERT_FILE: "",                                // OpenSSL: system CA file
  SSL_CERT_DIR: "",                                 // OpenSSL: system CA dir
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

/** Pick the registry URL: explicit flag > NPM_CONFIG_REGISTRY > NODE_REGISTRY_URL. */
export function resolveIndexUrl(explicit, cfg = null) {
  cfg = cfg || resolveEnv();
  return explicit || cfg.NPM_CONFIG_REGISTRY || cfg.NODE_REGISTRY_URL || null;
}

/** Translate resolved config into npm command-line flags. */
export function npmOptions(cfg) {
  const opts = [];
  const level = (cfg.NPM_CONFIG_LOGLEVEL || "").trim();
  if (level) opts.push("--loglevel", level);
  if (cfg.NPM_CONFIG_CAFILE) opts.push("--cafile", cfg.NPM_CONFIG_CAFILE);
  if (["false", "0", "no"].includes(String(cfg.NPM_CONFIG_STRICT_SSL).toLowerCase())) {
    opts.push("--strict-ssl", "false");
  }
  opts.push("--fetch-timeout", String(cfg.NPM_CONFIG_FETCH_TIMEOUT));
  opts.push("--fetch-retries", String(cfg.NPM_CONFIG_FETCH_RETRIES));
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
 * Return the list of versions a registry advertises for `pkg`.
 *
 * Versions are returned newest-first, mirroring how you'd read
 * `npm view <pkg> versions --json` (npm returns them oldest-first, so we
 * reverse). When `verbose` is set, the npm command and its raw output are
 * echoed so a failed or empty discovery can be debugged.
 */
export function getAvailableVersions(pkg, indexUrl, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  console.log(`Retrieving versions for '${pkg}' from ${indexUrl}...`);
  // Strip any verbose `--loglevel` for this query: we only parse a tiny JSON
  // blob, but a chatty loglevel (verbose/silly/debug) emits a flood of output
  // — enough to overflow spawnSync's default 1MB buffer, which kills the child
  // (status=null) and yields an empty stderr.
  const cmd = ["view", pkg, "versions", "--json", ...stripVerbose(npmOptions(cfg))];
  if (indexUrl) cmd.push("--registry", indexUrl);
  if (verbose) console.log(`  $ npm ${cmd.join(" ")}`);

  const res = spawnSync("npm", cmd, {
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
    console.error(`Error running 'npm view': ${detail}`);
    process.exit(1);
  }

  if (verbose) echo(res.stdout);
  let data;
  try {
    data = JSON.parse(res.stdout);
  } catch {
    console.error("Could not parse JSON from npm output.");
    return [];
  }
  // npm yields a JSON string for a single version, or a JSON array for many.
  let versions;
  if (typeof data === "string") {
    versions = [data];
  } else if (Array.isArray(data)) {
    versions = data.map((v) => String(v));
  } else {
    console.error("Unexpected JSON shape from npm output.");
    return [];
  }
  // npm lists oldest-first; reverse to newest-first like `pip index versions`.
  return versions.reverse();
}

/**
 * Create a fresh install prefix if needed; return its directory path.
 *
 * The prefix's npm is pinned to `npmVersion` (default `DEFAULT_NPM_VERSION`)
 * so install-tests run against a known npm. Pass `npmVersion=null` to keep
 * whatever npm is on PATH. `verbose` echoes the npm-pin output so a failed pin
 * can be debugged. `indexUrl` is the resolved registry the pin is fetched from,
 * so the pinned npm comes from the SAME registry the version probe and
 * install-tests use (pass `null` for npm's default).
 */
export function setupVenv(envDir, npmVersion = DEFAULT_NPM_VERSION, cfg = null, verbose = false, indexUrl = null) {
  cfg = cfg || resolveEnv();
  if (!fs.existsSync(envDir)) {
    console.log(`Creating install prefix at: ${envDir}`);
    fs.mkdirSync(envDir, { recursive: true });
  }
  // A minimal package.json keeps npm from walking up to a parent project.
  const pkgJson = path.join(envDir, "package.json");
  if (!fs.existsSync(pkgJson)) {
    fs.writeFileSync(pkgJson, JSON.stringify({ name: "npm-versions-sandbox", private: true }));
  }

  if (npmVersion) ensureNpmVersion(envDir, npmVersion, cfg, verbose, indexUrl);
  return envDir;
}

/** Pin the sandbox's local npm to `npmVersion` (installed from the registry). */
function ensureNpmVersion(envDir, npmVersion, cfg = null, verbose = false, indexUrl = null) {
  cfg = cfg || resolveEnv();
  console.log(`Ensuring npm==${npmVersion} in the test environment...`);
  const cmd = ["install", "--prefix", envDir, "--no-save", `npm@${npmVersion}`, ...npmOptions(cfg)];
  // Fetch the pinned npm from the same registry as discovery / install-tests,
  // not whatever ambient default npm would otherwise use.
  if (indexUrl) cmd.push("--registry", indexUrl);
  if (verbose) console.log(`  $ npm ${cmd.join(" ")}`);
  const res = spawnSync("npm", cmd, {
    encoding: "utf8",
    env: subprocessEnv(cfg),
    maxBuffer: 50 * 1024 * 1024, // defensive guard against future verbose output
  });
  if (verbose) echo(res.stdout, res.stderr);
  if (res.status !== 0) {
    console.error(
      `Warning: could not pin npm==${npmVersion}: ${lastLine(res.stderr) || "unknown error"}`,
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

/** True if npm `options` already carry a verbose loglevel flag. */
function hasVerbose(options) {
  for (let i = 0; i < options.length; i++) {
    const o = options[i];
    if (o === "-d" || o === "-dd" || o === "--verbose") return true;
    if (o === "--loglevel" && ["verbose", "silly", "info"].includes(options[i + 1])) return true;
  }
  return false;
}

// npm loglevels that flood stdout/stderr — these are the ones worth stripping
// from a discovery query whose output we parse as a tiny JSON blob.
const VERBOSE_LOGLEVELS = ["verbose", "silly", "info", "http", "debug"];

/**
 * npm `options` with any verbose `--loglevel <level>` pair removed.
 *
 * `npmOptions` emits `--loglevel <NPM_CONFIG_LOGLEVEL>`; if that level is a
 * chatty one (verbose/silly/debug/...) it can flood spawnSync's 1MB buffer on
 * the discovery query, killing the child. Drop the flag+value pair for that
 * case; quiet levels (warn/error) are left untouched.
 */
function stripVerbose(options) {
  const out = [];
  for (let i = 0; i < options.length; i++) {
    if (options[i] === "--loglevel" && VERBOSE_LOGLEVELS.includes(options[i + 1])) {
      i++; // skip the value too
      continue;
    }
    out.push(options[i]);
  }
  return out;
}

/**
 * Run `npm <cmd>`, echoing combined output live while capturing it.
 *
 * Resolves to `{ status, output }`. Used in verbose mode so the user watches
 * npm in real time (e.g. a slow build or a hang) yet the captured text still
 * feeds the JSON report.
 */
function stream(cmd, env) {
  return new Promise((resolve) => {
    const proc = spawn("npm", cmd, { env, stdio: ["ignore", "pipe", "pipe"] });
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
 * `prefixDir` is the install-prefix directory returned by `setupVenv`. Returns
 * the list of result objects. If `firstOnly` is set, stops after the first
 * version that installs successfully. When `verbose` is set, npm's full output
 * is streamed live (and a `--loglevel verbose` flag is added if none is
 * present) so install failures can be debugged; the captured output is also
 * folded into the report under `log`/`error`.
 */
export async function testInstallations(prefixDir, pkg, indexUrl, versions, outputJson, {
  firstOnly = false, cfg = null, verbose = false,
} = {}) {
  cfg = cfg || resolveEnv();
  const env = subprocessEnv(cfg);
  const options = npmOptions(cfg);
  const results = [];
  const installable = [];

  for (let idx = 0; idx < versions.length; idx++) {
    const version = versions[idx];
    const target = `${pkg}@${version}`;
    console.log(`[${idx + 1}/${versions.length}] Attempting to install: ${target}...`);

    const cmd = [
      "install", target, "--prefix", prefixDir, "--no-save", "--no-audit", "--no-fund",
      ...options,
    ];
    if (indexUrl) cmd.push("--registry", indexUrl);
    // Bump npm's own verbosity if the user wants detail and nothing already set it.
    if (verbose && !hasVerbose(options)) cmd.push("--loglevel", "verbose");

    let returncode, stdoutText, stderrText;
    if (verbose) {
      console.log(`  $ npm ${cmd.join(" ")}`);
      const [code, output] = await stream(cmd, env);
      returncode = code;
      stdoutText = stderrText = output; // streamed combined; same text both ways
    } else {
      const res = spawnSync("npm", cmd, {
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

const HELP = `usage: main.mjs [-h] [--registry INDEX_URL] [--venv-dir VENV_DIR]
                [--npm-version NPM_VERSION] [--output OUTPUT] [--limit LIMIT]
                [--first-only] [-v] package

Find installable versions of a package from an npm registry.

positional arguments:
  package               Package name to probe (e.g. left-pad).

options:
  -h, --help            show this help message and exit
  --registry, --index-url INDEX_URL
                        Custom npm registry URL. Defaults to $NPM_CONFIG_REGISTRY,
                        then $NODE_REGISTRY_URL, then https://registry.npmjs.org.
  --venv-dir VENV_DIR   Directory for the isolated test install prefix.
                        (default: .npm-test-install)
  --npm-version NPM_VERSION
                        npm version to pin in the test prefix ('none' to keep the
                        npm on PATH). (default: ${DEFAULT_NPM_VERSION})
  --output OUTPUT       Path to write the JSON report.
                        (default: installation_report.json)
  --limit LIMIT         Only test the newest N versions (default: all).
  --first-only          Stop after the first version that installs successfully.
  -v, --verbose         Stream full npm output for every step so failures are
                        debuggable.
`;

/** Parse a `main`-style argv list into an options object (mirrors argparse). */
export function parseArgs(argv = null) {
  argv = argv === null ? process.argv.slice(2) : argv;
  const args = {
    package: null,
    indexUrl: null,
    venvDir: ".npm-test-install",
    npmVersion: DEFAULT_NPM_VERSION,
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
    } else if (a === "--npm-version") {
      args.npmVersion = next();
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

  console.log(`Found ${versions.length} version(s) to test (registry: ${cfg.NODE_REGISTRY_NAME}).`);
  const npmVersion = String(args.npmVersion).toLowerCase() === "none" ? null : args.npmVersion;
  const prefixDir = setupVenv(args.venvDir, npmVersion, cfg, args.verbose, indexUrl);
  await testInstallations(prefixDir, args.package, indexUrl, versions, args.output, {
    firstOnly: args.firstOnly, cfg, verbose: args.verbose,
  });
  return 0;
}

// main() accepts an optional argv list. Pass one explicitly to drive the tool
// programmatically (e.g. from another script or a test); omit it and main()
// falls back to parseArgs(null), which reads from process.argv (normal CLI use).
//
// Example — probe the newest 5 versions of left-pad, stop at the first installable:
//     main(["left-pad", "--registry", "https://reg.example.com",
//           "--limit", "5", "--first-only"])
//
// Equivalent on the command line:
//     node main.mjs left-pad \
//         --registry https://reg.example.com --limit 5 --first-only

import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then((code) => process.exit(code)); // argv=null -> parseArgs reads process.argv
}
