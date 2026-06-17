#!/usr/bin/env node
/**
 * Find installable versions of a package from a (custom) Hex registry.
 *
 * Discovers every version the Hex.pm registry advertises for a package via its
 * HTTP JSON API (`https://hex.pm/api/packages/<pkg>`, `releases[].version`),
 * then attempts to fetch each one into an isolated scratch directory with
 * `mix hex.package fetch`, recording success/failure per version to a JSON
 * report.
 *
 * Example:
 *     node main.mjs jason \
 *         --index-url https://hex.pm
 *
 *     # only probe the newest 5 versions, stop at the first that fetches
 *     node main.mjs jason --index-url https://hex.pm \
 *         --limit 5 --first-only
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// Hex/mix tool version the test environment expects by default. Fetch-tests run
// against this mix+hex, so it governs resolver/fetch behaviour. Override via
// --hex-version (CLI) or the `hex` command (REPL). Hex is not pinnable the way
// pip is, so this is advisory: we surface it and warn on a mismatch.
export const DEFAULT_HEX_VERSION = "2.1.1";

// Environment knobs read via process.env, each falling back to the value the
// Elixir / Hex / TLS ecosystem uses by default ("industry standard"). mix/hex
// auto-read HEX_* vars from the environment; we resolve them explicitly so the
// documented default still applies when the var is unset, and so they can be
// surfaced (REPL `env`) and threaded into every mix invocation we build.
export const ENV_DEFAULTS = {
  HEX_VERBOSE: "0",                              // hex: quiet (0 = no debug)
  HEX_CACERTS_PATH: "",                          // hex: use system CA store
  HEX_API_URL: "https://hex.pm/api",             // hex: JSON API base
  HEX_MIRROR: "https://repo.hex.pm",             // hex: package repo mirror
  HEX_UNSAFE_HTTPS: "0",                          // hex: keep TLS verification
  HEX_HTTP_TIMEOUT: "15",                        // hex: 15s socket timeout
  HEX_HTTP_CONCURRENCY: "8",                     // hex: parallel fetches
  HEX_REGISTRY_URL: "https://hex.pm",            // our index-url fallback
  HEX_REGISTRY_NAME: "Hex.pm",                   // registry display name
  REQUESTS_CA_BUNDLE: "",                        // urllib: certifi CA bundle
  SSL_CERT_FILE: "",                             // OpenSSL: system CA file
  SSL_CERT_DIR: "",                              // OpenSSL: system CA dir
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

/** Pick the index URL: explicit flag > HEX_REGISTRY_URL > HEX_API_URL. */
export function resolveIndexUrl(explicit, cfg = null) {
  cfg = cfg || resolveEnv();
  return explicit || cfg.HEX_REGISTRY_URL || cfg.HEX_API_URL || null;
}

/**
 * Translate resolved config into mix/hex environment-ish flags.
 *
 * Hex exposes few invocation flags; most knobs are env vars (see `hexEnv`).
 * We still surface a verbosity flag analog so verbose runs are
 * self-documenting and mirror the pip reference's option list.
 */
export function hexOptions(cfg) {
  const opts = [];
  let level;
  const parsed = parseInt(cfg.HEX_VERBOSE, 10);
  level = Number.isNaN(parsed) ? 0 : parsed;
  if (level > 0) opts.push("--debug"); // mix: extra diagnostic output
  return opts;
}

/** Child-process environment with resolved Hex/TLS vars applied. */
export function hexEnv(cfg) {
  const env = { ...process.env };
  for (const name of TLS_ENV_VARS) {
    if (cfg[name]) env[name] = cfg[name];
  }
  // Thread the Hex registry/mirror/API knobs into mix so fetches hit the
  // configured registry rather than the global default.
  if (cfg.HEX_MIRROR) env.HEX_MIRROR = cfg.HEX_MIRROR;
  if (cfg.HEX_API_URL) env.HEX_API_URL = cfg.HEX_API_URL;
  if (cfg.HEX_CACERTS_PATH) env.HEX_CACERTS_PATH = cfg.HEX_CACERTS_PATH;
  if (cfg.HEX_UNSAFE_HTTPS && cfg.HEX_UNSAFE_HTTPS !== "0") {
    env.HEX_UNSAFE_HTTPS = cfg.HEX_UNSAFE_HTTPS;
  }
  return env;
}

/**
 * Derive the Hex JSON API base from the index URL or HEX_API_URL.
 *
 * The index URL the user passes is the registry root (`https://hex.pm`);
 * the JSON API lives under `/api`. If they already pointed at an `/api`
 * URL we use it as-is.
 */
function apiBase(indexUrl, cfg) {
  if (indexUrl && indexUrl.includes("/api")) {
    return indexUrl.replace(/\/+$/, "");
  }
  if (indexUrl) {
    return indexUrl.replace(/\/+$/, "") + "/api";
  }
  return cfg.HEX_API_URL.replace(/\/+$/, "");
}

/**
 * Return the list of versions the Hex registry advertises for `package`.
 *
 * Primary source is the Hex JSON API (`/packages/<pkg>`), whose `releases`
 * array is newest-first. If the HTTP call fails we fall back to parsing
 * `mix hex.info <pkg>`. Versions are returned newest-first. When `verbose` is
 * set, the URL/command and raw output are echoed so a failed or empty
 * discovery can be debugged.
 */
export async function getAvailableVersions(pkg, indexUrl, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  console.log(`Retrieving versions for '${pkg}' from ${indexUrl}...`);
  const api = apiBase(indexUrl, cfg);
  const url = `${api}/packages/${pkg}`;
  if (verbose) console.log(`  $ GET ${url}`);

  let payload;
  try {
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), parseInt(cfg.HEX_HTTP_TIMEOUT, 10) * 1000);
    let res;
    try {
      res = await fetch(url, { headers: { Accept: "application/json" }, signal: ac.signal });
    } finally {
      clearTimeout(timeout);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    payload = await res.text();
  } catch (e) {
    // degrade to the mix fallback
    if (verbose) {
      console.log(`  HTTP discovery failed (${e.message}); falling back to 'mix hex.info'.`);
    }
    return versionsViaMix(pkg, cfg, verbose);
  }

  if (verbose) echo(payload);
  let versions;
  try {
    const data = JSON.parse(payload);
    // `releases` is newest-first on the Hex API; keep that ordering.
    versions = (data.releases || []).filter((r) => r && r.version).map((r) => r.version);
  } catch (e) {
    console.error(`Could not parse Hex API JSON: ${e.message}`);
    return [];
  }
  if (!versions.length) {
    console.error("No 'releases' in Hex API response.");
  }
  return versions;
}

/** Fallback discovery: parse `mix hex.info <pkg>` 'Releases:' line. */
function versionsViaMix(pkg, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  const cmd = ["hex.info", pkg, ...hexOptions(cfg)];
  if (verbose) console.log(`  $ mix ${cmd.join(" ")}`);
  const res = spawnSync("mix", cmd, { encoding: "utf8", env: hexEnv(cfg) });
  if (res.error || res.status !== 0) {
    const stderr = res.error ? String(res.error) : (res.stderr || "");
    if (verbose) echo(res.stdout || "", stderr);
    console.error(`Error running 'mix hex.info': ${stderr.trim()}`);
    return [];
  }
  if (verbose) echo(res.stdout);
  const match = res.stdout.match(/Releases:\s*(.*)/);
  if (!match) {
    console.error("Could not find 'Releases:' in mix output.");
    return [];
  }
  return match[1].split(",").map((v) => v.trim()).filter((v) => v);
}

/**
 * Create a fresh scratch fetch directory if needed; return its path.
 *
 * Hex has no per-project virtualenv: the isolated sandbox is a throwaway
 * directory each `mix hex.package fetch` writes into. The directory is created
 * lazily and reused. `hexVersion` is advisory (Hex/mix is not pinnable like
 * pip); pass `hexVersion=null` to skip the version check. `verbose` echoes the
 * version probe so a mismatch can be debugged.
 */
export function setupVenv(envDir, hexVersion = DEFAULT_HEX_VERSION, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  if (!fs.existsSync(envDir)) {
    console.log(`Creating fetch sandbox at: ${envDir}`);
    fs.mkdirSync(envDir, { recursive: true });
  }

  if (hexVersion) ensureHexVersion(hexVersion, cfg, verbose);
  // The "handle" the test step needs is just the sandbox directory.
  return envDir;
}

/** Check the installed hex/mix against `hexVersion` (advisory only). */
function ensureHexVersion(hexVersion, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  console.log(`Ensuring hex==${hexVersion} in the test environment...`);
  const cmd = ["hex.info"];
  if (verbose) console.log(`  $ mix ${cmd.join(" ")}`);
  const res = spawnSync("mix", cmd, { encoding: "utf8", env: hexEnv(cfg) });
  if (verbose) echo(res.stdout, res.stderr);
  if (res.error || res.status !== 0) {
    console.error(
      `Warning: could not verify hex==${hexVersion}: ` +
        `${lastLine(res.stderr) || "mix/hex not found"}`,
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

/** True if mix `options` already carry a `--debug` flag. */
function hasVerbose(options) {
  return options.some((o) => o.startsWith("--debug"));
}

/**
 * Run `mix <cmd>`, echoing combined output live while capturing it.
 *
 * Resolves to `[returncode, combinedOutput]`. Used in verbose mode so the user
 * watches mix in real time (e.g. a slow fetch or a hang) yet the captured text
 * still feeds the JSON report.
 */
function stream(cmd, env) {
  return new Promise((resolve) => {
    const proc = spawn("mix", cmd, { env, stdio: ["ignore", "pipe", "pipe"] });
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
 * `envDir` is the scratch sandbox directory returned by `setupVenv`. Returns
 * the list of result objects. If `firstOnly` is set, stops after the first
 * version that fetches successfully. When `verbose` is set, mix's full output
 * is streamed live (and a `--debug` flag is added if none is present) so fetch
 * failures can be debugged; the captured output is also folded into the report
 * under `log`/`error`.
 */
export async function testInstallations(envDir, pkg, indexUrl, versions, outputJson, {
  firstOnly = false, cfg = null, verbose = false,
} = {}) {
  cfg = cfg || resolveEnv();
  const env = hexEnv(cfg);
  const options = hexOptions(cfg);
  const results = [];
  const installable = [];

  for (let idx = 0; idx < versions.length; idx++) {
    const version = versions[idx];
    const target = `${pkg} ${version}`;
    console.log(`[${idx + 1}/${versions.length}] Attempting to fetch: ${target}...`);

    // Each fetch lands in its own subdir of the sandbox so versions never
    // clobber one another and the sandbox stays inspectable on failure.
    const outDir = path.join(envDir, `${pkg}-${version}`);
    const cmd = [
      "hex.package",
      "fetch",
      pkg,
      version,
      "--output",
      outDir,
      ...options,
    ];
    // Bump mix's own verbosity if the user wants detail and nothing set it.
    if (verbose && !hasVerbose(options)) cmd.push("--debug");

    let returncode, stdoutText, stderrText;
    if (verbose) {
      console.log(`  $ mix ${cmd.join(" ")}`);
      const [code, output] = await stream(cmd, env);
      returncode = code;
      stdoutText = stderrText = output; // streamed combined; same text both ways
    } else {
      const res = spawnSync("mix", cmd, { encoding: "utf8", env });
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
                [--hex-version HEX_VERSION] [--output OUTPUT] [--limit LIMIT]
                [--first-only] [-v] package

Find installable versions of a package from a Hex registry.

positional arguments:
  package               Package name to probe (e.g. jason).

options:
  -h, --help            show this help message and exit
  --index-url INDEX_URL
                        Custom Hex registry URL. Defaults to $HEX_REGISTRY_URL,
                        then $HEX_API_URL, then https://hex.pm.
  --venv-dir VENV_DIR   Directory for the isolated fetch sandbox.
                        (default: .hex-test-fetch)
  --hex-version HEX_VERSION
                        hex version expected in the test sandbox ('none' to skip
                        the check). (default: ${DEFAULT_HEX_VERSION})
  --output OUTPUT       Path to write the JSON report.
                        (default: installation_report.json)
  --limit LIMIT         Only test the newest N versions (default: all).
  --first-only          Stop after the first version that fetches successfully.
  -v, --verbose         Stream full mix output for every step so failures are
                        debuggable.
`;

/** Parse a `main`-style argv list into an options object (mirrors argparse). */
export function parseArgs(argv = null) {
  argv = argv === null ? process.argv.slice(2) : argv;
  const args = {
    package: null,
    indexUrl: null,
    venvDir: ".hex-test-fetch",
    hexVersion: DEFAULT_HEX_VERSION,
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
    } else if (a === "--hex-version") {
      args.hexVersion = next();
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

  console.log(`Found ${versions.length} version(s) to test (registry: ${cfg.HEX_REGISTRY_NAME}).`);
  const hexVersion = String(args.hexVersion).toLowerCase() === "none" ? null : args.hexVersion;
  const envDir = setupVenv(args.venvDir, hexVersion, cfg, args.verbose);
  await testInstallations(envDir, args.package, indexUrl, versions, args.output, {
    firstOnly: args.firstOnly, cfg, verbose: args.verbose,
  });
  return 0;
}

// main() accepts an optional argv list. Pass one explicitly to drive the tool
// programmatically (e.g. from another script or a test); omit it and main()
// falls back to parseArgs(null), which reads from process.argv (normal CLI use).
//
// Example — probe the newest 5 versions of jason, stop at the first fetchable:
//     main(["jason", "--index-url", "https://hex.pm",
//           "--limit", "5", "--first-only"])
//
// Equivalent on the command line:
//     node main.mjs jason \
//         --index-url https://hex.pm --limit 5 --first-only

import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then((code) => process.exit(code)); // argv=null -> parseArgs reads process.argv
}
