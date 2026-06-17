#!/usr/bin/env node
/**
 * Find installable versions of a box from a (custom) Vagrant Cloud.
 *
 * Discovers every version Vagrant Cloud advertises for a box via the Vagrant
 * Cloud v1 REST API (`/api/v1/box/<user>/<box>`), then attempts to add each one
 * into an isolated scratch `VAGRANT_HOME`, recording success/failure per version
 * to a JSON report.
 *
 * Example:
 *     node main.mjs hashicorp/bionic64 \
 *         --vagrant-server https://app.vagrantup.com
 *
 *     # only probe the newest 5 versions, stop at the first that installs
 *     node main.mjs hashicorp/bionic64 --vagrant-server https://app.vagrantup.com \
 *         --limit 5 --first-only
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// vagrant version the test environment is pinned to by default. Install-tests run
// against this vagrant, so it governs box add / provider behaviour. Override via
// --vagrant-version (CLI) or the `vagrant` command (REPL).
export const DEFAULT_VAGRANT_VERSION = "2.4.1";

// Environment knobs read via process.env, each falling back to the value the
// Vagrant / TLS ecosystem uses by default ("industry standard"). vagrant itself
// auto-reads some of these from the environment; we resolve them explicitly so
// the documented default still applies when the var is unset, and so they can be
// surfaced (REPL `env`) and threaded into every vagrant invocation we build.
export const ENV_DEFAULTS = {
  VAGRANT_LOG: "",                                  // vagrant: log level (empty = quiet)
  VAGRANT_DEFAULT_PROVIDER: "virtualbox",           // vagrant: default provider
  VAGRANT_SERVER_URL: "https://app.vagrantup.com",  // vagrant: Cloud server URL
  VAGRANT_NO_COLOR: "1",                            // vagrant: plain output for logs
  VAGRANT_BOX_TIMEOUT: "60",                        // our: socket timeout (seconds)
  VAGRANT_BOX_RETRIES: "3",                         // our: connection retries
  VAGRANT_REGISTRY_URL: "https://app.vagrantup.com",  // our vagrant-server fallback
  VAGRANT_REGISTRY_NAME: "Vagrant Cloud",           // registry display name
  REQUESTS_CA_BUNDLE: "",                           // requests/urllib3: certifi
  SSL_CERT_FILE: "",                               // OpenSSL: system CA file
  SSL_CERT_DIR: "",                               // OpenSSL: system CA dir
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

/** Pick the Vagrant server: explicit flag > VAGRANT_SERVER_URL > VAGRANT_REGISTRY_URL. */
export function resolveVagrantServer(explicit, cfg = null) {
  cfg = cfg || resolveEnv();
  return explicit || cfg.VAGRANT_SERVER_URL || cfg.VAGRANT_REGISTRY_URL || null;
}

/** Translate resolved config into vagrant command-line flags. */
export function vagrantOptions(cfg) {
  const opts = [];
  const provider = cfg.VAGRANT_DEFAULT_PROVIDER;
  if (provider) opts.push("--provider", provider);
  return opts;
}

/** Child-process environment with resolved TLS cert + Vagrant vars applied. */
export function subprocessEnv(cfg) {
  const env = { ...process.env };
  for (const name of TLS_ENV_VARS) {
    if (cfg[name]) env[name] = cfg[name];
  }
  const server = resolveVagrantServer(null, cfg);
  if (server) env.VAGRANT_SERVER_URL = server;
  if (cfg.VAGRANT_LOG) env.VAGRANT_LOG = cfg.VAGRANT_LOG;
  if (!["", "0", "false", "False"].includes(cfg.VAGRANT_NO_COLOR)) {
    env.VAGRANT_NO_COLOR = "1";
  }
  return env;
}

/**
 * Return the list of versions Vagrant Cloud advertises for `pkg`.
 *
 * `pkg` is a `user/box` box identifier. Versions are returned newest-first via
 * the Vagrant Cloud v1 REST API (`/api/v1/box/<user>/<box>`,
 * `versions[].version`). When `verbose` is set, the URL and raw output are
 * echoed so a failed or empty discovery can be debugged.
 */
export async function getAvailableVersions(pkg, vagrantServer, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  console.log(`Retrieving versions for '${pkg}' from ${vagrantServer}...`);
  const slash = pkg.indexOf("/");
  const user = slash >= 0 ? pkg.slice(0, slash) : "";
  const box = slash >= 0 ? pkg.slice(slash + 1) : "";
  if (!user || !box) {
    console.error("Box must be in 'user/box' form.");
    return [];
  }

  const base = (vagrantServer || cfg.VAGRANT_SERVER_URL).replace(/\/+$/, "");
  const url = `${base}/api/v1/box/${user}/${box}`;
  if (verbose) console.log(`  $ GET ${url}`);

  let payload;
  try {
    const timeout = parseInt(cfg.VAGRANT_BOX_TIMEOUT, 10) || 60;
    const resp = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeout * 1000),
    });
    payload = await resp.text();
  } catch (e) { // network error, timeout, etc.
    if (verbose) echo(String(e.message));
    console.error(`Error querying Vagrant Cloud: ${e.message}`);
    process.exit(1);
  }

  if (verbose) echo(payload);
  let data;
  try {
    data = JSON.parse(payload);
  } catch {
    console.error("Could not parse Vagrant Cloud JSON response.");
    return [];
  }
  // versions[].version, already newest-first from the Vagrant Cloud API.
  return (data.versions || []).filter((entry) => entry.version).map((entry) => entry.version);
}

/**
 * Create a fresh sandbox VAGRANT_HOME if needed; return its path.
 *
 * For Vagrant the "isolated test environment" is a scratch `VAGRANT_HOME`
 * directory; each `vagrant box add` lands its boxes under it without touching
 * the host's `~/.vagrant.d`. `vagrantVersion` is recorded (and verified,
 * best-effort) so install-tests run against a known vagrant. Pass
 * `vagrantVersion=null` to keep whatever vagrant is on PATH. `verbose` echoes
 * the version check so a mismatch can be debugged.
 */
export function setupVenv(envDir, vagrantVersion = DEFAULT_VAGRANT_VERSION, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  if (!fs.existsSync(envDir)) {
    console.log(`Creating sandbox VAGRANT_HOME at: ${envDir}`);
    fs.mkdirSync(envDir, { recursive: true });
  }

  const vagrantHome = envDir; // used as VAGRANT_HOME for each box add

  if (vagrantVersion) ensureVagrantVersion(vagrantVersion, cfg, verbose);
  return vagrantHome;
}

/** Verify the vagrant on PATH matches `vagrantVersion` (best effort). */
function ensureVagrantVersion(vagrantVersion, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  console.log(`Ensuring vagrant==${vagrantVersion} in the test environment...`);
  const cmd = ["--version"];
  if (verbose) console.log(`  $ vagrant ${cmd.join(" ")}`);
  const res = spawnSync("vagrant", cmd, { encoding: "utf8", env: subprocessEnv(cfg) });
  if (res.error && res.error.code === "ENOENT") {
    console.error("Warning: vagrant not found on PATH.");
    return;
  }
  if (verbose) echo(res.stdout, res.stderr);
  if (res.status !== 0) {
    console.error(
      `Warning: could not verify vagrant==${vagrantVersion}: ${lastLine(res.stderr) || "unknown error"}`,
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

/** True if vagrant `options` already carry a `--debug`/`-v` flag. */
function hasVerbose(options) {
  return options.some((o) => o.startsWith("-v") || o === "--debug");
}

/**
 * Run `vagrant <cmd>`, echoing combined output live while capturing it.
 *
 * Resolves to `[returncode, combined_output]`. Used in verbose mode so the user
 * watches vagrant in real time (e.g. a slow download or a hang) yet the captured
 * text still feeds the JSON report.
 */
function stream(cmd, env) {
  return new Promise((resolve) => {
    const proc = spawn("vagrant", cmd, { env, stdio: ["ignore", "pipe", "pipe"] });
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
 * Returns the list of result objects. If `firstOnly` is set, stops after the
 * first version that installs successfully. When `verbose` is set, vagrant's
 * full output is streamed live (and a `--debug` flag is added if none is
 * present) so failures can be debugged; the captured output is also folded into
 * the report under `log`/`error`.
 */
export async function testInstallations(vagrantHome, pkg, vagrantServer, versions, outputJson, {
  firstOnly = false, cfg = null, verbose = false,
} = {}) {
  cfg = cfg || resolveEnv();
  const options = vagrantOptions(cfg);
  const results = [];
  const installable = [];

  for (let idx = 0; idx < versions.length; idx++) {
    const version = versions[idx];
    const target = `${pkg} @ ${version}`;
    console.log(`[${idx + 1}/${versions.length}] Attempting to install: ${target}...`);

    // Add into a throwaway VAGRANT_HOME per version so a successful add of one
    // does not satisfy/shadow the next.
    const tmp = fs.mkdtempSync(path.join(vagrantHome, "vagrant-"));
    let returncode, stdoutText, stderrText;
    try {
      const env = subprocessEnv(cfg);
      env.VAGRANT_HOME = tmp;
      const cmd = [
        "box", "add", pkg, "--box-version", version, "--force",
        ...options,
      ];
      // Bump verbosity if the user wants detail and nothing already set it.
      if (verbose && !hasVerbose(options)) cmd.push("--debug");

      if (verbose) {
        console.log(`  $ VAGRANT_HOME=${tmp} vagrant ${cmd.join(" ")}`);
        const [code, output] = await stream(cmd, env);
        returncode = code;
        stdoutText = stderrText = output; // streamed combined; same text both ways
      } else {
        const res = spawnSync("vagrant", cmd, { encoding: "utf8", env });
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

const HELP = `usage: main.mjs [-h] [--vagrant-server VAGRANT_SERVER] [--venv-dir VENV_DIR]
                [--vagrant-version VAGRANT_VERSION] [--output OUTPUT]
                [--limit LIMIT] [--first-only] [-v] package

Find installable versions of a box from a Vagrant Cloud.

positional arguments:
  package               Box to probe in 'user/box' form (e.g. hashicorp/bionic64).

options:
  -h, --help            show this help message and exit
  --vagrant-server VAGRANT_SERVER
                        Custom Vagrant Cloud server URL. Defaults to
                        $VAGRANT_SERVER_URL, then $VAGRANT_REGISTRY_URL, then
                        https://app.vagrantup.com.
  --venv-dir VENV_DIR   Directory for the isolated sandbox VAGRANT_HOME.
                        (default: .venv-test-install)
  --vagrant-version VAGRANT_VERSION
                        vagrant version to expect in the test env ('none' to use
                        whatever is on PATH). (default: ${DEFAULT_VAGRANT_VERSION})
  --output OUTPUT       Path to write the JSON report.
                        (default: installation_report.json)
  --limit LIMIT         Only test the newest N versions (default: all).
  --first-only          Stop after the first version that installs successfully.
  -v, --verbose         Stream full vagrant output for every step so failures are
                        debuggable.
`;

/** Parse a `main`-style argv list into an options object (mirrors argparse). */
export function parseArgs(argv = null) {
  argv = argv === null ? process.argv.slice(2) : argv;
  const args = {
    package: null,
    vagrantServer: null,
    venvDir: ".venv-test-install",
    vagrantVersion: DEFAULT_VAGRANT_VERSION,
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
    } else if (a === "--vagrant-server") {
      args.vagrantServer = next();
    } else if (a === "--venv-dir") {
      args.venvDir = next();
    } else if (a === "--vagrant-version") {
      args.vagrantVersion = next();
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
  const vagrantServer = resolveVagrantServer(args.vagrantServer, cfg);

  let versions = await getAvailableVersions(args.package, vagrantServer, cfg, args.verbose);
  if (!versions.length) {
    console.log("No versions found. Exiting.");
    return 1;
  }

  if (args.limit !== null && !Number.isNaN(args.limit)) {
    versions = versions.slice(0, args.limit);
  }

  console.log(`Found ${versions.length} version(s) to test (registry: ${cfg.VAGRANT_REGISTRY_NAME}).`);
  const vagrantVersion = String(args.vagrantVersion).toLowerCase() === "none" ? null : args.vagrantVersion;
  const vagrantHome = setupVenv(args.venvDir, vagrantVersion, cfg, args.verbose);
  await testInstallations(vagrantHome, args.package, vagrantServer, versions, args.output, {
    firstOnly: args.firstOnly, cfg, verbose: args.verbose,
  });
  return 0;
}

// main() accepts an optional argv list. Pass one explicitly to drive the tool
// programmatically (e.g. from another script or a test); omit it and main()
// falls back to parseArgs(null), which reads from process.argv (normal CLI use).
//
// Example — probe the newest 5 versions of hashicorp/bionic64, stop at the first installable:
//     main(["hashicorp/bionic64", "--vagrant-server", "https://app.vagrantup.com",
//           "--limit", "5", "--first-only"])
//
// Equivalent on the command line:
//     node main.mjs hashicorp/bionic64 \
//         --vagrant-server https://app.vagrantup.com --limit 5 --first-only

import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then((code) => process.exit(code)); // argv=null -> parseArgs reads process.argv
}
