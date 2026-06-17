#!/usr/bin/env node
/**
 * Find fetchable versions of a formula from the Homebrew registry.
 *
 * Discovers what version(s) the Homebrew API advertises for a formula via the
 * formula JSON endpoint (`/api/formula/<formula>.json`), then attempts to
 * `brew fetch` each token into an isolated throwaway download cache, recording
 * success/failure per token to a JSON report.
 *
 * NOTE: Homebrew installs/fetches only the CURRENT stable of a formula. Its API
 * mainly exposes that single stable version (plus separate *versioned formulae*
 * like `python@3.11`); historical-version listing/testing is therefore
 * best-effort — `brew fetch` validates the formula is fetchable but cannot pin
 * arbitrary past versions. Versioned-formula NAMES, however, fetch directly.
 *
 * Example:
 *     node main.mjs wget \
 *         --source https://formulae.brew.sh
 *
 *     # only probe the newest 5 tokens, stop at the first that fetches
 *     node main.mjs wget --source https://formulae.brew.sh \
 *         --limit 5 --first-only
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";

// brew tool version the test environment is expected to use by default.
// Fetch-tests run against this toolchain, so it governs fetch/cache behaviour.
// Override via --brew-version (CLI) or the `brew` command (REPL).
export const DEFAULT_BREW_VERSION = "4.3.0";

// Environment knobs read via process.env, each falling back to the value the
// Homebrew / TLS ecosystem uses by default ("industry standard"). brew itself
// auto-reads HOMEBREW_* vars from the environment; we resolve them explicitly so
// the documented default still applies when the var is unset, and so they can be
// surfaced (REPL `env`) and threaded into every brew invocation we build.
export const ENV_DEFAULTS = {
  HOMEBREW_VERBOSE: "0",                               // brew: quiet (0 = normal)
  HOMEBREW_CERT: "",                                   // brew: use system store
  HOMEBREW_API: "https://formulae.brew.sh/api/formula",  // formula JSON base for listing
  HOMEBREW_SOURCE: "https://formulae.brew.sh",         // Homebrew API base for fetch
  HOMEBREW_TRUSTED_HOST: "",                           // brew: no extra trusted hosts
  HOMEBREW_DEFAULT_TIMEOUT: "15",                      // brew: 15s socket timeout
  HOMEBREW_RETRIES: "5",                               // brew: 5 connection retries
  BREW_REGISTRY_URL: "https://formulae.brew.sh",       // our source fallback
  BREW_REGISTRY_NAME: "Homebrew",                      // registry display name
  REQUESTS_CA_BUNDLE: "",                              // requests/urllib3: certifi
  SSL_CERT_FILE: "",                                   // OpenSSL: system CA file
  SSL_CERT_DIR: "",                                    // OpenSSL: system CA dir
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

/** Pick the source URL: explicit flag > HOMEBREW_SOURCE > BREW_REGISTRY_URL. */
export function resolveIndexUrl(explicit, cfg = null) {
  cfg = cfg || resolveEnv();
  return explicit || cfg.HOMEBREW_SOURCE || cfg.BREW_REGISTRY_URL || null;
}

/** Translate resolved config into brew command-line flags. */
export function brewOptions(cfg) {
  const opts = [];
  const parsed = parseInt(cfg.HOMEBREW_VERBOSE, 10);
  const level = Number.isNaN(parsed) ? 0 : parsed;
  if (level > 0) opts.push("--verbose"); // brew: bump fetch verbosity
  // brew has no meaningful per-call cert flag; HOMEBREW_CERT carries no native
  // brew option, so we keep it addressable (it can be threaded via the env in
  // subprocessEnv) without emitting a flag brew wouldn't understand.
  // brew fetch likewise has no per-call timeout/retry flags; brew reads them
  // from the environment, so they ride along via subprocessEnv. We still keep
  // the resolved values addressable for parity with the reference shape.
  return opts;
}

/** Child-process environment with resolved TLS cert + Homebrew vars applied. */
export function subprocessEnv(cfg) {
  const env = { ...process.env };
  for (const name of TLS_ENV_VARS) {
    if (cfg[name]) env[name] = cfg[name];
  }
  // brew honours these from the environment; thread the resolved values in.
  env.HOMEBREW_DEFAULT_TIMEOUT = String(cfg.HOMEBREW_DEFAULT_TIMEOUT);
  env.HOMEBREW_RETRIES = String(cfg.HOMEBREW_RETRIES);
  // Keep fetches fast and deterministic: don't auto-update the formula tap on
  // every invocation.
  env.HOMEBREW_NO_AUTO_UPDATE = "1";
  return env;
}

/**
 * Return the list of tokens Homebrew advertises for `formula`.
 *
 * Tokens are returned newest-first: the current stable version first, then any
 * *versioned formulae* names (e.g. `python@3.11`) as-is. Homebrew's API mainly
 * exposes the CURRENT stable version of a formula plus those separate versioned
 * formulae, so historical-version listing is best-effort — there is no full
 * per-version history here. When `verbose` is set, the API URL and its raw
 * payload are echoed so a failed or empty discovery can be debugged.
 */
export async function getAvailableVersions(formula, indexUrl, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  console.log(`Retrieving versions for '${formula}' from ${indexUrl}...`);
  // The formula JSON resource keys its document by the formula name.
  const api = cfg.HOMEBREW_API.replace(/\/+$/, "");
  const url = `${api}/${formula}.json`;
  if (verbose) console.log(`  $ GET ${url}`);

  let payload;
  try {
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), parseInt(cfg.HOMEBREW_DEFAULT_TIMEOUT, 10) * 1000);
    let res;
    try {
      res = await fetch(url, { headers: { Accept: "application/json" }, signal: ac.signal });
    } finally {
      clearTimeout(timeout);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    payload = await res.text();
  } catch (e) {
    // fetch raises a zoo of errors; treat all as fatal here
    if (verbose) echo(String(e));
    console.error(`Error querying Homebrew formula API: ${e.message}`);
    process.exit(1);
  }

  if (verbose) echo(payload);
  let data;
  try {
    data = JSON.parse(payload);
  } catch {
    console.error("Could not parse JSON from Homebrew formula API.");
    return [];
  }
  const versions = data.versions;
  if (!versions) {
    console.error("Could not find 'versions' in Homebrew formula JSON.");
    return [];
  }
  // Current stable first, then versioned-formulae NAMES (e.g. python@3.11) as-is.
  const tokens = [];
  const stable = versions.stable;
  if (stable) tokens.push(String(stable).trim());
  for (const name of data.versioned_formulae || []) {
    if (name && String(name).trim()) tokens.push(String(name).trim());
  }
  return tokens;
}

/**
 * Create a fresh throwaway download cache if needed; return its directory.
 *
 * The sandbox is just a temp directory used as the brew download/cache target
 * (`brew fetch` downloads bottles there). `brewVersion` records the toolchain
 * the tests are expected to run against (default `DEFAULT_BREW_VERSION`). Pass
 * `brewVersion=null` to skip the toolchain-check echo. `verbose` echoes any
 * setup output so a failed setup can be debugged.
 */
export function setupVenv(envDir, brewVersion = DEFAULT_BREW_VERSION, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  if (!fs.existsSync(envDir)) {
    console.log(`Creating throwaway brew cache dir at: ${envDir}`);
  }
  fs.mkdirSync(envDir, { recursive: true });

  if (brewVersion) ensureBrewVersion(envDir, brewVersion, cfg, verbose);
  return envDir;
}

/** Report the brew version (the toolchain fetch-tests run against). */
function ensureBrewVersion(envDir, brewVersion, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  console.log(`Ensuring brew>=${brewVersion} in the test environment...`);
  const cmd = ["--version"];
  if (verbose) console.log(`  $ brew ${cmd.join(" ")}`);
  const res = spawnSync("brew", cmd, { encoding: "utf8", env: subprocessEnv(cfg) });
  if (verbose) echo(res.stdout, res.stderr);
  if (res.error || res.status !== 0) {
    console.error(
      `Warning: could not verify brew>=${brewVersion}: ` +
        `${lastLine(res.stderr) || "unknown error"}`,
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

/** True if brew `options` already carry a `--verbose` flag. */
function hasVerbose(options) {
  return options.some((o) => o === "--verbose");
}

/**
 * Run `brew <cmd>`, echoing combined output live while capturing it.
 *
 * Resolves to `[returncode, combinedOutput]`. Used in verbose mode so the user
 * watches brew in real time (e.g. a slow fetch or a hang) yet the captured text
 * still feeds the JSON report.
 */
function stream(cmd, env) {
  return new Promise((resolve) => {
    const proc = spawn("brew", cmd, { env, stdio: ["ignore", "pipe", "pipe"] });
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
 * Attempt to fetch each token; write an incremental JSON report.
 *
 * Returns the list of result objects. If `firstOnly` is set, stops after the
 * first token that fetches successfully. When `verbose` is set, brew's full
 * output is streamed live (and a `--verbose` flag is added if none is present)
 * so fetch failures can be debugged; the captured output is also folded into
 * the report under `log`/`error`.
 *
 * NOTE: brew only installs/fetches the CURRENT stable of a formula, so
 * historical-version testing is best-effort — `brew fetch` validates that the
 * formula is fetchable but cannot pin arbitrary past versions. For
 * versioned-formula NAMES (e.g. `python@3.11`) `brew fetch` works directly. The
 * per-iteration "version" field is therefore the formula-or-version TOKEN being
 * fetched, not necessarily a pinned version.
 */
export async function testInstallations(venvDir, formula, indexUrl, versions, outputJson, {
  firstOnly = false, cfg = null, verbose = false,
} = {}) {
  cfg = cfg || resolveEnv();
  const env = subprocessEnv(cfg);
  // brew fetch downloads bottles into HOMEBREW_CACHE; point it at the sandbox
  // so downloads land in the throwaway dir.
  env.HOMEBREW_CACHE = venvDir;
  const options = brewOptions(cfg);
  const results = [];
  const installable = [];

  for (let idx = 0; idx < versions.length; idx++) {
    const version = versions[idx];
    const target = version;
    console.log(`[${idx + 1}/${versions.length}] Attempting to fetch: ${target}...`);

    // brew fetch downloads only (NO install). The token is a formula name
    // (or a versioned-formula name like python@3.11).
    const cmd = [
      "fetch",
      version,
      ...options,
    ];
    // Bump brew's own verbosity if the user wants detail and nothing set it.
    if (verbose && !hasVerbose(options)) cmd.push("--verbose");

    let returncode, stdoutText, stderrText;
    if (verbose) {
      console.log(`  $ brew ${cmd.join(" ")}`);
      const [code, output] = await stream(cmd, env);
      returncode = code;
      stdoutText = stderrText = output; // streamed combined; same text both ways
    } else {
      const res = spawnSync("brew", cmd, { encoding: "utf8", env });
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
    fs.writeFileSync(outputJson, JSON.stringify(results, null, 4));

    if (firstOnly && installable.length) {
      console.log(`  First fetchable token found: ${installable[0]} (stopping).`);
      break;
    }
  }

  console.log(`\nTesting complete! Results saved to ${outputJson}`);
  if (installable.length) {
    console.log(`Fetchable tokens (${installable.length}): ${installable.join(", ")}`);
  } else {
    console.log("No fetchable tokens found.");
  }
  return results;
}

const HELP = `usage: main.mjs [-h] [--source SOURCE] [--venv-dir VENV_DIR]
                [--brew-version BREW_VERSION] [--output OUTPUT] [--limit LIMIT]
                [--first-only] [-v] formula

Find fetchable versions of a formula from the Homebrew registry.

positional arguments:
  formula               Formula name to probe (e.g. wget).

options:
  -h, --help            show this help message and exit
  --source SOURCE       Homebrew API base URL. Defaults to $HOMEBREW_SOURCE,
                        then $BREW_REGISTRY_URL, then https://formulae.brew.sh.
  --venv-dir VENV_DIR   Directory for the isolated throwaway brew download cache.
                        (default: .venv-test-install)
  --brew-version BREW_VERSION
                        brew version expected in the test env ('none' to skip the
                        check). (default: ${DEFAULT_BREW_VERSION})
  --output OUTPUT       Path to write the JSON report.
                        (default: installation_report.json)
  --limit LIMIT         Only test the newest N tokens (default: all).
  --first-only          Stop after the first token that fetches successfully.
  -v, --verbose         Stream full brew output for every step so failures are
                        debuggable.
`;

/** Parse a `main`-style argv list into an options object (mirrors argparse). */
export function parseArgs(argv = null) {
  argv = argv === null ? process.argv.slice(2) : argv;
  const args = {
    formula: null,
    source: null,
    venvDir: ".venv-test-install",
    brewVersion: DEFAULT_BREW_VERSION,
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
    } else if (a === "--source") {
      args.source = next();
    } else if (a === "--venv-dir") {
      args.venvDir = next();
    } else if (a === "--brew-version") {
      args.brewVersion = next();
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
    console.error("main.mjs: error: the following arguments are required: formula");
    process.exit(2);
  }
  args.formula = positionals[0];
  return args;
}

export async function main(argv = null) {
  const args = parseArgs(argv);

  const cfg = resolveEnv();
  const indexUrl = resolveIndexUrl(args.source, cfg);

  let versions = await getAvailableVersions(args.formula, indexUrl, cfg, args.verbose);
  if (!versions.length) {
    console.log("No versions found. Exiting.");
    return 1;
  }

  if (args.limit !== null && !Number.isNaN(args.limit)) {
    versions = versions.slice(0, args.limit);
  }

  console.log(`Found ${versions.length} version(s) to test (registry: ${cfg.BREW_REGISTRY_NAME}).`);
  const brewVersion = String(args.brewVersion).toLowerCase() === "none" ? null : args.brewVersion;
  const venvDir = setupVenv(args.venvDir, brewVersion, cfg, args.verbose);
  await testInstallations(venvDir, args.formula, indexUrl, versions, args.output, {
    firstOnly: args.firstOnly, cfg, verbose: args.verbose,
  });
  return 0;
}

// main() accepts an optional argv list. Pass one explicitly to drive the tool
// programmatically (e.g. from another script or a test); omit it and main()
// falls back to parseArgs(null), which reads from process.argv (normal CLI use).
//
// Example — probe the newest 5 tokens of wget, stop at the first fetchable:
//     main(["wget", "--source", "https://formulae.brew.sh",
//           "--limit", "5", "--first-only"])
//
// Equivalent on the command line:
//     node main.mjs wget \
//         --source https://formulae.brew.sh --limit 5 --first-only

import { fileURLToPath } from "node:url";
import path from "node:path";
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then((code) => process.exit(code)); // argv=null -> parseArgs reads process.argv
}
