#!/usr/bin/env node
/**
 * Find installable versions of a package from a (custom) npm registry via pnpm.
 *
 * Discovers every version a registry advertises for a package via
 * `pnpm view <pkg> versions --json`, then attempts to add each one in an
 * isolated temp project, recording success/failure per version to a JSON report.
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

// pnpm version the test environment is pinned to by default. Install-tests run
// against this pnpm, so it governs resolver/lockfile behaviour. Override via
// --pnpm-version (CLI) or the `pnpm` command (REPL).
export const DEFAULT_PNPM_VERSION = "9.15.0";

// Environment knobs read via process.env, each falling back to the value the
// Node.js / pnpm / TLS ecosystem uses by default ("industry standard"). pnpm
// itself auto-reads NPM_CONFIG_* vars from the environment; we resolve them
// explicitly so the documented default still applies when the var is unset, and
// so they can be surfaced (REPL `env`) and threaded into every pnpm invocation.
export const ENV_DEFAULTS = {
  NPM_CONFIG_LOGLEVEL: "warn",                      // pnpm: log level (warn = quiet)
  NPM_CONFIG_CAFILE: "",                            // pnpm: use bundled/system CA store
  NPM_CONFIG_REGISTRY: "https://registry.npmjs.org", // pnpm: package registry
  NPM_CONFIG_STRICT_SSL: "true",                    // pnpm: verify TLS certificates
  NPM_CONFIG_FETCH_TIMEOUT: "300000",               // pnpm: 300s fetch timeout (ms)
  NPM_CONFIG_FETCH_RETRIES: "2",                    // pnpm: 2 fetch retries
  NODE_REGISTRY_URL: "https://registry.npmjs.org",  // our registry fallback
  NODE_REGISTRY_NAME: "pnpm",                       // registry display name
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

/** Translate resolved config into pnpm command-line flags. */
export function pnpmOptions(cfg) {
  const opts = [];
  const level = (cfg.NPM_CONFIG_LOGLEVEL || "").trim();
  if (level) opts.push("--loglevel", level);
  if (cfg.NPM_CONFIG_CAFILE) opts.push("--config.cafile", cfg.NPM_CONFIG_CAFILE);
  if (["false", "0", "no"].includes(String(cfg.NPM_CONFIG_STRICT_SSL).toLowerCase())) {
    opts.push("--config.strict-ssl", "false");
  }
  opts.push("--config.fetch-timeout", String(cfg.NPM_CONFIG_FETCH_TIMEOUT));
  opts.push("--config.fetch-retries", String(cfg.NPM_CONFIG_FETCH_RETRIES));
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
 * `pnpm view <pkg> versions --json` (pnpm returns them oldest-first, so we
 * reverse). When `verbose` is set, the pnpm command and its raw output are
 * echoed so a failed or empty discovery can be debugged.
 */
export function getAvailableVersions(pkg, indexUrl, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  console.log(`Retrieving versions for '${pkg}' from ${indexUrl}...`);
  const cmd = ["view", pkg, "versions", "--json", ...pnpmOptions(cfg)];
  if (indexUrl) cmd.push("--registry", indexUrl);
  if (verbose) console.log(`  $ pnpm ${cmd.join(" ")}`);

  const res = spawnSync("pnpm", cmd, {
    encoding: "utf8",
    env: subprocessEnv(cfg),
  });
  if (res.status !== 0) {
    if (verbose) echo(res.stdout, res.stderr);
    console.error(`Error running 'pnpm view': ${(res.stderr || "").trim()}`);
    process.exit(1);
  }

  if (verbose) echo(res.stdout);
  let data;
  try {
    data = JSON.parse(res.stdout);
  } catch {
    console.error("Could not parse JSON from pnpm output.");
    return [];
  }
  // pnpm yields a JSON string for a single version, or a JSON array for many.
  let versions;
  if (typeof data === "string") {
    versions = [data];
  } else if (Array.isArray(data)) {
    versions = data.map((v) => String(v));
  } else {
    console.error("Unexpected JSON shape from pnpm output.");
    return [];
  }
  // pnpm lists oldest-first; reverse to newest-first like `pip index versions`.
  return versions.reverse();
}

/**
 * Create a fresh temp project dir if needed; return its directory path.
 *
 * The sandbox's pnpm is pinned to `pnpmVersion` (default
 * `DEFAULT_PNPM_VERSION`) so install-tests run against a known pnpm. Pass
 * `pnpmVersion=null` to keep whatever pnpm is on PATH. `verbose` echoes
 * the pnpm-pin output so a failed pin can be debugged.
 */
export function setupVenv(envDir, pnpmVersion = DEFAULT_PNPM_VERSION, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  if (!fs.existsSync(envDir)) {
    console.log(`Creating temp project at: ${envDir}`);
    fs.mkdirSync(envDir, { recursive: true });
  }
  // A minimal package.json keeps pnpm from walking up to a parent workspace.
  const pkgJson = path.join(envDir, "package.json");
  if (!fs.existsSync(pkgJson)) {
    fs.writeFileSync(pkgJson, JSON.stringify({ name: "pnpm-versions-sandbox", private: true }));
  }

  if (pnpmVersion) ensurePnpmVersion(envDir, pnpmVersion, cfg, verbose);
  return envDir;
}

/**
 * Pin the sandbox to `pnpmVersion` by writing packageManager in package.json.
 *
 * pnpm (via corepack) honours the `packageManager` field, so pinning here
 * keeps the temp project's install-tests on a known pnpm without touching the
 * global toolchain.
 */
function ensurePnpmVersion(envDir, pnpmVersion, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  console.log(`Ensuring pnpm==${pnpmVersion} in the test environment...`);
  const pkgJson = path.join(envDir, "package.json");
  try {
    const data = JSON.parse(fs.readFileSync(pkgJson, "utf8"));
    data.packageManager = `pnpm@${pnpmVersion}`;
    fs.writeFileSync(pkgJson, JSON.stringify(data));
    if (verbose) echo(`set packageManager = pnpm@${pnpmVersion} in ${pkgJson}`);
  } catch (e) {
    console.error(`Warning: could not pin pnpm==${pnpmVersion}: ${e.message}`);
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

/** True if pnpm `options` already carry a verbose loglevel flag. */
function hasVerbose(options) {
  for (let i = 0; i < options.length; i++) {
    if (options[i] === "--loglevel" && i + 1 < options.length &&
        ["verbose", "silly", "info", "debug"].includes(options[i + 1])) {
      return true;
    }
  }
  return false;
}

/**
 * Run `pnpm <cmd>`, echoing combined output live while capturing it.
 *
 * Resolves to `[returncode, combinedOutput]`. Used in verbose mode so the user
 * watches pnpm in real time (e.g. a slow build or a hang) yet the captured
 * text still feeds the JSON report.
 */
function stream(cmd, env, cwd) {
  return new Promise((resolve) => {
    const proc = spawn("pnpm", cmd, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
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
 * `pipPath` is the temp project directory returned by `setupVenv`.
 * Returns the list of result objects. If `firstOnly` is set, stops after
 * the first version that installs successfully. When `verbose` is set,
 * pnpm's full output is streamed live (and a `--loglevel debug` flag is added
 * if none is present) so install failures can be debugged; the captured output
 * is also folded into the report under `log`/`error`.
 */
export async function testInstallations(pipPath, pkg, indexUrl, versions, outputJson, {
  firstOnly = false, cfg = null, verbose = false,
} = {}) {
  cfg = cfg || resolveEnv();
  const env = subprocessEnv(cfg);
  const options = pnpmOptions(cfg);
  const results = [];
  const installable = [];

  for (let idx = 0; idx < versions.length; idx++) {
    const version = versions[idx];
    const target = `${pkg}@${version}`;
    console.log(`[${idx + 1}/${versions.length}] Attempting to install: ${target}...`);

    const cmd = [
      "add", target, "--dir", pipPath, "--save-prod", "--ignore-scripts", ...options,
    ];
    if (indexUrl) cmd.push("--registry", indexUrl);
    // Bump pnpm's own verbosity if the user wants detail and nothing already set it.
    if (verbose && !hasVerbose(options)) cmd.push("--loglevel", "debug");

    let returncode, stdoutText, stderrText;
    if (verbose) {
      console.log(`  $ pnpm ${cmd.join(" ")}`);
      const [code, output] = await stream(cmd, env, pipPath);
      returncode = code;
      stdoutText = stderrText = output; // streamed combined; same text both ways
    } else {
      const res = spawnSync("pnpm", cmd, { encoding: "utf8", env, cwd: pipPath });
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
                [--pnpm-version PNPM_VERSION] [--output OUTPUT] [--limit LIMIT]
                [--first-only] [-v] package

Find installable versions of a package from a registry via pnpm.

positional arguments:
  package               Package name to probe (e.g. left-pad).

options:
  -h, --help            show this help message and exit
  --registry, --index-url INDEX_URL
                        Custom npm registry URL. Defaults to $NPM_CONFIG_REGISTRY,
                        then $NODE_REGISTRY_URL, then https://registry.npmjs.org.
  --venv-dir VENV_DIR   Directory for the isolated test temp project.
                        (default: .pnpm-test-install)
  --pnpm-version PNPM_VERSION
                        pnpm version to pin in the test project ('none' to keep the
                        pnpm on PATH). (default: ${DEFAULT_PNPM_VERSION})
  --output OUTPUT       Path to write the JSON report.
                        (default: installation_report.json)
  --limit LIMIT         Only test the newest N versions (default: all).
  --first-only          Stop after the first version that installs successfully.
  -v, --verbose         Stream full pnpm output for every step so failures are
                        debuggable.
`;

/** Parse a `main`-style argv list into an options object (mirrors argparse). */
export function parseArgs(argv = null) {
  argv = argv === null ? process.argv.slice(2) : argv;
  const args = {
    package: null,
    indexUrl: null,
    venvDir: ".pnpm-test-install",
    pnpmVersion: DEFAULT_PNPM_VERSION,
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
    } else if (a === "--pnpm-version") {
      args.pnpmVersion = next();
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
  const pnpmVersion = String(args.pnpmVersion).toLowerCase() === "none" ? null : args.pnpmVersion;
  const pipPath = setupVenv(args.venvDir, pnpmVersion, cfg, args.verbose);
  await testInstallations(pipPath, args.package, indexUrl, versions, args.output, {
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
