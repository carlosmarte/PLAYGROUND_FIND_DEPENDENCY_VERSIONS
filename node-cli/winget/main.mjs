#!/usr/bin/env node
/**
 * Find installable versions of a package from a winget source.
 *
 * Discovers every version a source advertises for a package by running
 * `winget show --id <package> --versions` and parsing its output, then attempts
 * to install each one with `winget install`, recording success/failure per
 * version to a JSON report.
 *
 * IMPORTANT — winget is Windows-only and has NO public HTTP listing API: both
 * listing AND install-testing are performed by shelling out to the `winget` CLI
 * itself, which only exists on Windows with winget on PATH. This tool will NOT
 * function on Linux/macOS hosts — the `winget` subprocess calls will fail there
 * (no such executable). The container image we ship (a Linux node:slim) is for
 * parity/structure only; real use requires Windows.
 *
 * Example:
 *     node main.mjs Git.Git --source winget
 *
 *     # only probe the newest 5 versions, stop at the first that installs
 *     node main.mjs Git.Git --source winget --limit 5 --first-only
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// winget version the test environment is expected to use by default. Install-
// tests run against this toolchain, so it governs source/resolver behaviour.
// Override via --winget-version (CLI) or the `winget` command (REPL).
export const DEFAULT_WINGET_VERSION = "1.8.0";

// Environment knobs read via process.env, each falling back to the value the
// winget / TLS ecosystem uses by default ("industry standard"). winget itself
// reads some of these from the environment; we resolve them explicitly so the
// documented default still applies when the var is unset, and so they can be
// surfaced (REPL `env`) and threaded into every winget invocation we build.
export const ENV_DEFAULTS = {
  WINGET_VERBOSE: "0",                   // winget: quiet (0 = normal)
  WINGET_CERT: "",                       // winget: use system store (no-op here)
  WINGET_API: "",                        // winget has NO public HTTP listing API;
                                         // listing is via the `winget` CLI itself
  WINGET_SOURCE: "winget",               // the default winget source name
  WINGET_TRUSTED_HOST: "",               // winget: no extra trusted hosts
  WINGET_DEFAULT_TIMEOUT: "15",          // winget: 15s socket timeout
  WINGET_RETRIES: "5",                   // winget: 5 connection retries
  WINGET_REGISTRY_URL: "winget",         // our source fallback (a source NAME)
  WINGET_REGISTRY_NAME: "Windows Package Manager",  // registry display name
  REQUESTS_CA_BUNDLE: "",                // requests/urllib3: certifi
  SSL_CERT_FILE: "",                     // OpenSSL: system CA file
  SSL_CERT_DIR: "",                      // OpenSSL: system CA dir
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

/**
 * Pick the source: explicit flag > WINGET_SOURCE > WINGET_REGISTRY_URL.
 *
 * Note: for winget the "indexUrl"/source is a source NAME (e.g. `winget`),
 * NOT an http URL — it is passed to `--source` verbatim.
 */
export function resolveIndexUrl(explicit, cfg = null) {
  cfg = cfg || resolveEnv();
  return explicit || cfg.WINGET_SOURCE || cfg.WINGET_REGISTRY_URL || null;
}

/** Translate resolved config into winget command-line flags. */
export function wingetOptions(cfg) {
  const opts = [];
  let level = parseInt(cfg.WINGET_VERBOSE, 10);
  if (Number.isNaN(level)) level = 0;
  if (level > 0) opts.push("--verbose-logs"); // winget: emit verbose logs
  if (cfg.WINGET_CERT) {
    // winget has no per-call config-file flag like nuget; kept as a no-op for
    // parity with the reference shape (it rides along addressable).
  }
  // winget install has no per-call timeout/retry flags; those values ride along
  // via subprocessEnv. We keep them resolved for parity.
  return opts;
}

/** Child-process environment with resolved TLS cert vars applied. */
export function subprocessEnv(cfg) {
  const env = { ...process.env };
  for (const name of TLS_ENV_VARS) {
    if (cfg[name]) env[name] = cfg[name];
  }
  return env;
}

/**
 * Return the list of versions a source advertises for `pkg`.
 *
 * Runs `winget show --id <package> --versions` (adding `--source` when an
 * `indexUrl` is set). winget prints a header, then a separator line of dashes,
 * then one version per line. We split stdout into lines, find the line of
 * dashes, and take every subsequent non-empty line as a version. winget already
 * lists newest-first, so we return the parsed list as-is.
 *
 * IMPORTANT: this is Windows-only — `winget` only exists on Windows with it on
 * PATH. On other hosts the subprocess will fail (returncode != 0) and we
 * exit(1). When `verbose` is set, the command and its raw output are echoed so a
 * failed or empty discovery can be debugged.
 */
export function getAvailableVersions(pkg, indexUrl, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  console.log(`Retrieving versions for '${pkg}' from ${indexUrl}...`);
  const cmd = ["show", "--id", pkg, "--versions"];
  if (indexUrl) cmd.push("--source", indexUrl);
  if (verbose) console.log(`  $ winget ${cmd.join(" ")}`);

  const res = spawnSync("winget", cmd, { encoding: "utf8", env: subprocessEnv(cfg) });
  if (verbose) echo(res.stdout, res.stderr);
  if (res.status !== 0) {
    console.error(
      `Error querying winget: ${lastLine(res.stderr) || lastLine(res.stdout) || "unknown error"}`,
    );
    process.exit(1);
  }

  // Parse: find the separator line of dashes, then take subsequent non-empty
  // lines as versions. winget already lists newest-first.
  const lines = (res.stdout || "").split(/\r?\n/);
  const versions = [];
  let seenSeparator = false;
  for (const line of lines) {
    const stripped = line.trim();
    if (!seenSeparator) {
      // A line consisting mostly of dashes marks the start of the list.
      if (stripped && /^-{3,}$/.test(stripped)) seenSeparator = true;
      continue;
    }
    if (stripped) versions.push(stripped);
  }
  if (!versions.length) {
    console.error("Could not parse any versions from winget output.");
    return [];
  }
  return versions;
}

/**
 * Create a fresh throwaway sandbox dir if needed; return its directory.
 *
 * The sandbox is a temp directory used as the `--download` target for the
 * non-mutating download path. `wingetVersion` records the toolchain the tests
 * are expected to run against (default `DEFAULT_WINGET_VERSION`). Pass
 * `wingetVersion=null` to skip the toolchain-check echo. `verbose` echoes the
 * setup output so a failed setup can be debugged.
 */
export function setupVenv(envDir, wingetVersion = DEFAULT_WINGET_VERSION, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  if (!fs.existsSync(envDir)) {
    console.log(`Creating throwaway winget sandbox at: ${envDir}`);
  }
  fs.mkdirSync(envDir, { recursive: true });

  if (wingetVersion) ensureWingetVersion(envDir, wingetVersion, cfg, verbose);
  return envDir;
}

/** Report the winget version (the toolchain install-tests run against). */
function ensureWingetVersion(envDir, wingetVersion, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  console.log(`Ensuring winget>=${wingetVersion} in the test environment...`);
  const cmd = ["--version"];
  if (verbose) console.log(`  $ winget ${cmd.join(" ")}`);
  const res = spawnSync("winget", cmd, { encoding: "utf8", env: subprocessEnv(cfg) });
  if (verbose) echo(res.stdout, res.stderr);
  if (res.status !== 0) {
    console.error(
      `Warning: could not verify winget>=${wingetVersion}: ${lastLine(res.stderr) || "unknown error"}`,
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

/** True if winget `options` already carry a `--verbose-logs` flag. */
function hasVerbose(options) {
  return options.some((o) => o === "--verbose-logs");
}

/**
 * Run `winget <cmd>`, echoing combined output live while capturing it.
 *
 * Resolves to `[returncode, combined_output]`. Used in verbose mode so the user
 * watches winget in real time (e.g. a slow install or a hang) yet the captured
 * text still feeds the JSON report.
 */
function stream(cmd, env) {
  return new Promise((resolve) => {
    const proc = spawn("winget", cmd, { env, stdio: ["ignore", "pipe", "pipe"] });
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
 * first version that installs successfully. When `verbose` is set, winget's full
 * output is streamed live (and a `--verbose-logs` flag is added if none is
 * present) so install failures can be debugged; the captured output is also
 * folded into the report under `log`/`error`.
 *
 * IMPORTANT: this performs a REAL install on Windows (`winget install`). A
 * non-mutating alternative is
 * `winget download --id <package> --version <ver> --download-directory <venvDir>`
 * which fetches the installer into the sandbox without applying it. This is
 * Windows-only — the `winget` subprocess fails on other hosts.
 */
export async function testInstallations(venvDir, pkg, indexUrl, versions, outputJson, {
  firstOnly = false, cfg = null, verbose = false,
} = {}) {
  cfg = cfg || resolveEnv();
  const env = subprocessEnv(cfg);
  const options = wingetOptions(cfg);
  const results = [];
  const installable = [];

  for (let idx = 0; idx < versions.length; idx++) {
    const version = versions[idx];
    const target = `${pkg}@${version}`;
    console.log(`[${idx + 1}/${versions.length}] Attempting to install: ${target}...`);

    const cmd = [
      "install", "--id", pkg, "--version", version,
      "--accept-package-agreements", "--accept-source-agreements",
      ...options,
    ];
    if (indexUrl) cmd.push("--source", indexUrl);
    // Bump winget's own verbosity if the user wants detail and nothing set it.
    if (verbose && !hasVerbose(options)) cmd.push("--verbose-logs");

    let returncode, stdoutText, stderrText;
    if (verbose) {
      console.log(`  $ winget ${cmd.join(" ")}`);
      const [code, output] = await stream(cmd, env);
      returncode = code;
      stdoutText = stderrText = output; // streamed combined; same text both ways
    } else {
      const res = spawnSync("winget", cmd, { encoding: "utf8", env });
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

const HELP = `usage: main.mjs [-h] [--source SOURCE] [--venv-dir VENV_DIR]
                [--winget-version WINGET_VERSION] [--output OUTPUT]
                [--limit LIMIT] [--first-only] [-v] package

Find installable versions of a package from a winget source.

positional arguments:
  package               Package id to probe (e.g. Git.Git).

options:
  -h, --help            show this help message and exit
  --source SOURCE       winget source name. Defaults to $WINGET_SOURCE, then
                        $WINGET_REGISTRY_URL, then 'winget'.
  --venv-dir VENV_DIR   Directory for the isolated throwaway winget sandbox.
                        (default: .venv-test-install)
  --winget-version WINGET_VERSION
                        winget version expected in the test env ('none' to skip
                        the check). (default: ${DEFAULT_WINGET_VERSION})
  --output OUTPUT       Path to write the JSON report.
                        (default: installation_report.json)
  --limit LIMIT         Only test the newest N versions (default: all).
  --first-only          Stop after the first version that installs successfully.
  -v, --verbose         Stream full winget output for every step so failures are
                        debuggable.
`;

/** Parse a `main`-style argv list into an options object (mirrors argparse). */
export function parseArgs(argv = null) {
  argv = argv === null ? process.argv.slice(2) : argv;
  const args = {
    package: null,
    source: null,
    venvDir: ".venv-test-install",
    wingetVersion: DEFAULT_WINGET_VERSION,
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
    } else if (a === "--winget-version") {
      args.wingetVersion = next();
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
  const indexUrl = resolveIndexUrl(args.source, cfg);

  let versions = getAvailableVersions(args.package, indexUrl, cfg, args.verbose);
  if (!versions.length) {
    console.log("No versions found. Exiting.");
    return 1;
  }

  if (args.limit !== null && !Number.isNaN(args.limit)) {
    versions = versions.slice(0, args.limit);
  }

  console.log(`Found ${versions.length} version(s) to test (registry: ${cfg.WINGET_REGISTRY_NAME}).`);
  const wingetVersion = String(args.wingetVersion).toLowerCase() === "none" ? null : args.wingetVersion;
  const venvDir = setupVenv(args.venvDir, wingetVersion, cfg, args.verbose);
  await testInstallations(venvDir, args.package, indexUrl, versions, args.output, {
    firstOnly: args.firstOnly, cfg, verbose: args.verbose,
  });
  return 0;
}

// main() accepts an optional argv list. Pass one explicitly to drive the tool
// programmatically (e.g. from another script or a test); omit it and main()
// falls back to parseArgs(null), which reads from process.argv (normal CLI use).
//
// Example — probe the newest 5 versions of Git.Git, stop at the first
// installable:
//     main(["Git.Git", "--source", "winget", "--limit", "5", "--first-only"])
//
// Equivalent on the command line:
//     node main.mjs Git.Git --source winget --limit 5 --first-only

import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then((code) => process.exit(code)); // argv=null -> parseArgs reads process.argv
}
