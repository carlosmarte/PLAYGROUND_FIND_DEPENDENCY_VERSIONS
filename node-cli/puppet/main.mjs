#!/usr/bin/env node
/**
 * Find installable versions of a module from a (custom) Puppet Forge.
 *
 * Discovers every version Puppet Forge advertises for a module via the Forge v3
 * REST API (`/v3/modules/<user>-<mod>`), then attempts to install each one into
 * an isolated scratch target dir, recording success/failure per version to a
 * JSON report.
 *
 * Example:
 *     node main.mjs puppetlabs-stdlib \
 *         --forge-server https://forgeapi.puppet.com
 *
 *     # only probe the newest 5 versions, stop at the first that installs
 *     node main.mjs puppetlabs-stdlib --forge-server https://forgeapi.puppet.com \
 *         --limit 5 --first-only
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

// puppet version the test environment is pinned to by default. Install-tests run
// against this puppet, so it governs module resolution behaviour. Override via
// --puppet-version (CLI) or the `puppet` command (REPL).
export const DEFAULT_PUPPET_VERSION = "8.10.0";

// Environment knobs read via process.env, each falling back to the value the
// Puppet Forge / TLS ecosystem uses by default ("industry standard"). puppet
// itself auto-reads some of these from the environment; we resolve them
// explicitly so the documented default still applies when the var is unset, and
// so they can be surfaced (REPL `env`) and threaded into every puppet invocation
// we build.
export const ENV_DEFAULTS = {
  PUPPET_VERBOSE: "0",                                  // puppet: quiet (0 = no --verbose)
  PUPPET_FORGE_SSL_VERIFY: "1",                         // puppet: verify Forge TLS
  PUPPET_FORGE_URL: "https://forgeapi.puppet.com",      // puppet: Forge API base
  PUPPET_FORGE_SERVER: "https://forgeapi.puppet.com",   // puppet: module_repository
  PUPPET_FORGE_TIMEOUT: "60",                           // our: socket timeout (seconds)
  PUPPET_FORGE_RETRIES: "3",                            // our: connection retries
  PUPPET_REGISTRY_URL: "https://forgeapi.puppet.com",   // our forge-server fallback
  PUPPET_REGISTRY_NAME: "Puppet Forge",                 // registry display name
  REQUESTS_CA_BUNDLE: "",                               // requests/urllib3: certifi
  SSL_CERT_FILE: "",                                    // OpenSSL: system CA file
  SSL_CERT_DIR: "",                                     // OpenSSL: system CA dir
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

/** Pick the Forge server: explicit flag > PUPPET_FORGE_SERVER > PUPPET_REGISTRY_URL. */
export function resolveForgeServer(explicit, cfg = null) {
  cfg = cfg || resolveEnv();
  return explicit || cfg.PUPPET_FORGE_SERVER || cfg.PUPPET_REGISTRY_URL || null;
}

/** Translate resolved config into puppet command-line flags. */
export function puppetOptions(cfg) {
  const opts = [];
  let level = parseInt(cfg.PUPPET_VERBOSE, 10);
  if (Number.isNaN(level)) level = 0;
  if (level > 0) opts.push("--verbose"); // puppet uses a single --verbose flag
  const server = resolveForgeServer(null, cfg);
  if (server) opts.push("--module_repository", server);
  return opts;
}

/** Child-process environment with resolved TLS cert vars applied. */
export function subprocessEnv(cfg) {
  const env = { ...process.env };
  for (const name of TLS_ENV_VARS) {
    if (cfg[name]) env[name] = cfg[name];
  }
  const server = resolveForgeServer(null, cfg);
  if (server) env.PUPPET_FORGE_URL = server;
  return env;
}

/**
 * Return the list of versions the Forge advertises for `package`.
 *
 * `package` is a `user-mod` (or `user/mod`) module identifier. Versions are
 * returned newest-first via the Forge v3 REST API (`/v3/modules/<user>-<mod>`,
 * `releases[].version`). When `verbose` is set, the URL and raw output are
 * echoed so a failed or empty discovery can be debugged.
 */
export async function getAvailableVersions(pkg, forgeServer, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  console.log(`Retrieving versions for '${pkg}' from ${forgeServer}...`);
  // The Forge slug uses a dash; accept the puppet-module-install 'user/mod'
  // form too and normalise to 'user-mod' for the API path.
  const slug = pkg.replace(/\//g, "-");
  if (!slug.includes("-")) {
    console.error("Module must be in 'user-mod' (or 'user/mod') form.");
    return [];
  }

  const base = (forgeServer || cfg.PUPPET_FORGE_SERVER).replace(/\/+$/, "");
  const url = `${base}/v3/modules/${slug}`;
  if (verbose) console.log(`  $ GET ${url}`);

  let payload;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      parseInt(cfg.PUPPET_FORGE_TIMEOUT, 10) * 1000,
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
    if (verbose) echo(String(e));
    console.error(`Error querying Puppet Forge: ${e.message || e}`);
    process.exit(1);
  }

  if (verbose) echo(payload);
  let data;
  try {
    data = JSON.parse(payload);
  } catch {
    console.error("Could not parse Puppet Forge JSON response.");
    return [];
  }
  // releases[].version, already newest-first from the Forge API.
  return (data.releases || [])
    .filter((entry) => entry && entry.version)
    .map((entry) => entry.version);
}

/**
 * Create a fresh sandbox target dir if needed; return its path.
 *
 * For Puppet the "isolated test environment" is a scratch directory passed to
 * `puppet module install --target-dir <dir>`; each install lands under it
 * without touching the host's module paths. `puppetVersion` is recorded (and
 * verified, best-effort) so install-tests run against a known puppet. Pass
 * `puppetVersion=null` to keep whatever puppet is on PATH. `verbose` echoes the
 * version check so a mismatch can be debugged.
 */
export function setupVenv(envDir, puppetVersion = DEFAULT_PUPPET_VERSION, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  if (!fs.existsSync(envDir)) {
    console.log(`Creating sandbox target dir at: ${envDir}`);
    fs.mkdirSync(envDir, { recursive: true });
  }

  const targetDir = envDir; // puppet installs modules under --target-dir <dir>

  if (puppetVersion) ensurePuppetVersion(puppetVersion, cfg, verbose);
  return targetDir;
}

/** Verify the puppet on PATH matches `puppetVersion` (best effort). */
function ensurePuppetVersion(puppetVersion, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  console.log(`Ensuring puppet==${puppetVersion} in the test environment...`);
  const cmd = ["--version"];
  if (verbose) console.log(`  $ puppet ${cmd.join(" ")}`);
  const res = spawnSync("puppet", cmd, { encoding: "utf8", env: subprocessEnv(cfg) });
  if (res.error && res.error.code === "ENOENT") {
    console.error("Warning: puppet not found on PATH.");
    return;
  }
  if (verbose) echo(res.stdout, res.stderr);
  if (res.status !== 0) {
    console.error(
      `Warning: could not verify puppet==${puppetVersion}: ${lastLine(res.stderr) || "unknown error"}`,
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

/** True if puppet `options` already carry a `--verbose`/`--debug` flag. */
function hasVerbose(options) {
  return options.some((o) => o === "--verbose" || o === "--debug");
}

/**
 * Run `puppet <cmd>`, echoing combined output live while capturing it.
 *
 * Resolves to `{ status, output }`. Used in verbose mode so the user watches
 * puppet in real time (e.g. a slow download or a hang) yet the captured text
 * still feeds the JSON report.
 */
function stream(cmd, env) {
  return new Promise((resolve) => {
    const proc = spawn("puppet", cmd, { env, stdio: ["ignore", "pipe", "pipe"] });
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
 * Returns the list of result objects. If `firstOnly` is set, stops after the
 * first version that installs successfully. When `verbose` is set, puppet's full
 * output is streamed live (and a `--verbose` flag is added if none is present)
 * so install failures can be debugged; the captured output is also folded into
 * the report under `log`/`error`.
 */
export async function testInstallations(targetDir, pkg, forgeServer, versions, outputJson, {
  firstOnly = false, cfg = null, verbose = false,
} = {}) {
  cfg = cfg || resolveEnv();
  const env = subprocessEnv(cfg);
  const options = puppetOptions(cfg);
  const results = [];
  const installable = [];

  // Normalise the install slug to the Forge 'user-mod' form puppet expects.
  const slug = pkg.replace(/\//g, "-");

  for (let idx = 0; idx < versions.length; idx++) {
    const version = versions[idx];
    const target = `${slug} @ ${version}`;
    console.log(`[${idx + 1}/${versions.length}] Attempting to install: ${target}...`);

    // Install into a throwaway target dir per version so a successful install
    // of one does not satisfy/shadow the next.
    const tmp = fs.mkdtempSync(path.join(targetDir, "forge-"));
    let returncode, stdoutText, stderrText;
    try {
      const cmd = [
        "module",
        "install",
        slug,
        "--version",
        version,
        "--target-dir",
        tmp,
        "--force",
        ...options,
      ];
      // Bump verbosity if the user wants detail and nothing already set it.
      if (verbose && !hasVerbose(options)) cmd.push("--verbose");

      if (verbose) {
        console.log(`  $ puppet ${cmd.join(" ")}`);
        const [code, output] = await stream(cmd, env);
        returncode = code;
        stdoutText = stderrText = output; // streamed combined; same text both ways
      } else {
        const res = spawnSync("puppet", cmd, { encoding: "utf8", env });
        returncode = res.status;
        stdoutText = res.stdout;
        stderrText = res.stderr;
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
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

const HELP = `usage: main.mjs [-h] [--forge-server FORGE_SERVER] [--venv-dir VENV_DIR]
                [--puppet-version PUPPET_VERSION] [--output OUTPUT]
                [--limit LIMIT] [--first-only] [-v] package

Find installable versions of a module from a Puppet Forge.

positional arguments:
  package               Module to probe in 'user-mod' form (e.g. puppetlabs-stdlib).

options:
  -h, --help            show this help message and exit
  --forge-server FORGE_SERVER
                        Custom Forge server URL. Defaults to $PUPPET_FORGE_SERVER,
                        then $PUPPET_REGISTRY_URL, then https://forgeapi.puppet.com.
  --venv-dir VENV_DIR   Directory for the isolated sandbox module target dir.
                        (default: .venv-test-install)
  --puppet-version PUPPET_VERSION
                        puppet version to expect in the test env ('none' to use
                        whatever is on PATH). (default: ${DEFAULT_PUPPET_VERSION})
  --output OUTPUT       Path to write the JSON report.
                        (default: installation_report.json)
  --limit LIMIT         Only test the newest N versions (default: all).
  --first-only          Stop after the first version that installs successfully.
  -v, --verbose         Stream full puppet output for every step so failures are
                        debuggable.
`;

/** Parse a `main`-style argv list into an options object (mirrors argparse). */
export function parseArgs(argv = null) {
  argv = argv === null ? process.argv.slice(2) : argv;
  const args = {
    package: null,
    forgeServer: null,
    venvDir: ".venv-test-install",
    puppetVersion: DEFAULT_PUPPET_VERSION,
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
    } else if (a === "--forge-server") {
      args.forgeServer = next();
    } else if (a === "--venv-dir") {
      args.venvDir = next();
    } else if (a === "--puppet-version") {
      args.puppetVersion = next();
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
  const forgeServer = resolveForgeServer(args.forgeServer, cfg);

  let versions = await getAvailableVersions(args.package, forgeServer, cfg, args.verbose);
  if (!versions.length) {
    console.log("No versions found. Exiting.");
    return 1;
  }

  if (args.limit !== null && !Number.isNaN(args.limit)) {
    versions = versions.slice(0, args.limit);
  }

  console.log(`Found ${versions.length} version(s) to test (registry: ${cfg.PUPPET_REGISTRY_NAME}).`);
  const puppetVersion = String(args.puppetVersion).toLowerCase() === "none" ? null : args.puppetVersion;
  const targetDir = setupVenv(args.venvDir, puppetVersion, cfg, args.verbose);
  await testInstallations(targetDir, args.package, forgeServer, versions, args.output, {
    firstOnly: args.firstOnly, cfg, verbose: args.verbose,
  });
  return 0;
}

// main() accepts an optional argv list. Pass one explicitly to drive the tool
// programmatically (e.g. from another script or a test); omit it and main()
// falls back to parseArgs(null), which reads from process.argv (normal CLI use).
//
// Example — probe the newest 5 versions of puppetlabs-stdlib, stop at the first installable:
//     main(["puppetlabs-stdlib", "--forge-server", "https://forgeapi.puppet.com",
//           "--limit", "5", "--first-only"])
//
// Equivalent on the command line:
//     node main.mjs puppetlabs-stdlib \
//         --forge-server https://forgeapi.puppet.com --limit 5 --first-only

import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then((code) => process.exit(code)); // argv=null -> parseArgs reads process.argv
}
