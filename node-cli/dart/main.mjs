#!/usr/bin/env node
/**
 * Find installable versions of a package from a (custom) Dart pub registry.
 *
 * Discovers every version a registry advertises for a package via the pub.dev
 * HTTP JSON API (`https://pub.dev/api/packages/<pkg>`), then attempts to add
 * each one to an isolated throwaway Dart package, recording success/failure per
 * version to a JSON report.
 *
 * Example:
 *     node main.mjs http \
 *         --hosted-url https://pub.dev
 *
 *     # only probe the newest 5 versions, stop at the first that installs
 *     node main.mjs http --hosted-url https://pub.dev \
 *         --limit 5 --first-only
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import process from "node:process";

// dart version the test environment is pinned to by default. Install-tests run
// against this dart, so it governs resolver/build behaviour. Override via
// --dart-version (CLI) or the `dart` command (REPL). Note: the dart SDK is
// provided by the host toolchain; we record the pin we expect.
export const DEFAULT_DART_VERSION = "3.5.4";

// Environment knobs read via process.env, each falling back to the value the
// Dart / pub ecosystem uses by default ("industry standard"). The pub client
// auto-reads PUB_HOSTED_URL from the environment; we resolve it explicitly so
// the documented default still applies when the var is unset, and so they can be
// surfaced (REPL `env`) and threaded into every dart invocation we build.
export const ENV_DEFAULTS = {
  PUB_VERBOSE: "0",                              // pub: quiet (0 = no --verbose)
  PUB_HOSTED_URL: "https://pub.dev",             // pub: hosted package server
  PUB_API_URL: "https://pub.dev",                // our version-listing API base
  PUB_DEFAULT_TIMEOUT: "30",                     // pub: socket timeout (s)
  PUB_RETRIES: "5",                              // pub: connection retries
  DART_REGISTRY_URL: "https://pub.dev",          // our hosted-url fallback
  DART_REGISTRY_NAME: "pub.dev",                 // registry display name
  SSL_CERT_FILE: "",                             // OpenSSL: system CA file
  SSL_CERT_DIR: "",                              // OpenSSL: system CA dir
  CURL_CA_BUNDLE: "",                            // curl/libcurl: CA bundle
};

// TLS vars passed through to child processes via the environment (no CLI flag).
const TLS_ENV_VARS = ["SSL_CERT_FILE", "SSL_CERT_DIR", "CURL_CA_BUNDLE"];

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

/** Pick the hosted URL: explicit flag > PUB_HOSTED_URL > DART_REGISTRY_URL. */
export function resolveIndexUrl(explicit, cfg = null) {
  cfg = cfg || resolveEnv();
  return explicit || cfg.PUB_HOSTED_URL || cfg.DART_REGISTRY_URL || null;
}

/**
 * Translate resolved config into dart/pub command-line flags.
 *
 * Dart's pub has a small option surface; we accumulate the knobs we honour
 * (verbosity) as a list that `testInstallations` weaves into the
 * `dart pub add` invocation. Timeout/retries are threaded via the environment
 * (`subprocessEnv`) since pub reads them from there.
 */
export function pubOptions(cfg) {
  const opts = [];
  let level;
  try {
    level = parseInt(cfg.PUB_VERBOSE, 10);
    if (Number.isNaN(level)) level = 0;
  } catch {
    level = 0;
  }
  if (level > 0) opts.push("--verbose"); // dart pub --verbose
  return opts;
}

/** Child-process environment with resolved TLS cert vars + hosted URL applied. */
export function subprocessEnv(cfg) {
  const env = { ...process.env };
  for (const name of TLS_ENV_VARS) {
    if (cfg[name]) env[name] = cfg[name];
  }
  // pub reads its hosted server from PUB_HOSTED_URL; thread the resolved value
  // so every `dart pub add` targets the chosen registry.
  if (cfg.PUB_HOSTED_URL) env.PUB_HOSTED_URL = cfg.PUB_HOSTED_URL;
  return env;
}

/**
 * Return the list of versions a registry advertises for `package`.
 *
 * Versions are returned newest-first, mirroring the pub.dev API ordering. pub
 * has no native "list all versions" CLI, so we query the HTTP JSON API
 * (`<PUB_API_URL>/api/packages/<pkg>`) via global `fetch`: the document carries
 * a `versions` array of objects each with a `version` field, ordered
 * oldest-first, which we reverse to newest-first. When `verbose` is set, the
 * request URL and raw output are echoed so a failed or empty discovery can be
 * debugged.
 */
export async function getAvailableVersions(pkg, indexUrl, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  console.log(`Retrieving versions for '${pkg}' from ${indexUrl}...`);
  const apiUrl = String(cfg.PUB_API_URL).replace(/\/+$/, "");
  const url = `${apiUrl}/api/packages/${pkg}`;
  if (verbose) console.log(`  $ GET ${url}`);

  let raw;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), parseInt(cfg.PUB_DEFAULT_TIMEOUT, 10) * 1000);
    let resp;
    try {
      resp = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    raw = await resp.text();
  } catch (e) {
    // fetch raises a family of errors; treat all as fatal.
    console.error(`Error querying pub.dev API: ${e.message || e}`);
    process.exit(1);
  }

  if (verbose) echo(raw);
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    console.error("Could not parse pub.dev JSON response.");
    return [];
  }

  const entries = data.versions || [];
  const versions = entries.map((e) => e.version).filter((v) => v);
  if (!versions.length) {
    console.error("Could not find any versions in pub.dev output.");
    return [];
  }
  return versions.reverse(); // API is oldest-first -> newest-first
}

/**
 * Create a fresh throwaway Dart package if needed; return its package dir.
 *
 * Each install-test runs `dart pub add` inside a scratch Dart package
 * (created via `dart create`) rather than against the host, so probes never
 * mutate a real project. The package is pinned conceptually to `dartVersion`
 * (default `DEFAULT_DART_VERSION`) — the dart SDK itself is host-provided, so
 * the pin is recorded/echoed rather than re-bootstrapped. Pass
 * `dartVersion=null` to skip the pin announcement. `verbose` echoes the
 * provisioning step so a failed setup can be debugged.
 */
export function setupVenv(envDir, dartVersion = DEFAULT_DART_VERSION, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  if (!fs.existsSync(envDir)) {
    console.log(`Creating throwaway Dart package at: ${envDir}`);
    fs.mkdirSync(envDir, { recursive: true });
    dartCreate(envDir, cfg, verbose);
  }

  const pkgDir = path.resolve(envDir); // dart pub add runs in this directory

  if (dartVersion) ensureDartVersion(pkgDir, dartVersion, cfg, verbose);
  return pkgDir;
}

/** Scaffold a minimal Dart package the install-tests can add deps into. */
function dartCreate(envDir, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  const cmd = ["create", "--force", "-t", "package", envDir];
  if (verbose) console.log(`  $ dart ${cmd.join(" ")}`);
  const res = spawnSync("dart", cmd, {
    encoding: "utf8",
    env: subprocessEnv(cfg),
    maxBuffer: 50 * 1024 * 1024, // defensive guard against future verbose output
  });
  if (verbose) echo(res.stdout, res.stderr);
  if (res.status !== 0) {
    // status is null when the child was killed by a signal (e.g. buffer
    // overflow SIGTERM) — stderr is empty then, so fall back to the signal
    // name / spawn error rather than report a blank/misleading message.
    const detail = lastLine(res.stderr)
      || (res.signal && `terminated by signal ${res.signal}`)
      || (res.error && res.error.message)
      || "unknown error";
    console.error(
      `Warning: could not scaffold Dart package: ${detail}`,
    );
  }
}

/** Record the dart version the test package expects (host-provided SDK). */
function ensureDartVersion(pkgDir, dartVersion, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  console.log(`Ensuring dart==${dartVersion} in the test environment...`);
  const cmd = ["--version"];
  if (verbose) console.log(`  $ dart ${cmd.join(" ")}`);
  const res = spawnSync("dart", cmd, {
    encoding: "utf8",
    env: subprocessEnv(cfg),
    maxBuffer: 50 * 1024 * 1024, // defensive guard against future verbose output
  });
  if (verbose) echo(res.stdout, res.stderr);
  if (res.status !== 0) {
    // status is null when the child was killed by a signal (e.g. buffer
    // overflow SIGTERM) — stderr is empty then, so fall back to the signal
    // name / spawn error rather than report a blank/misleading message.
    const detail = lastLine(res.stderr)
      || (res.signal && `terminated by signal ${res.signal}`)
      || (res.error && res.error.message)
      || "unknown error";
    console.error(
      `Warning: could not confirm dart==${dartVersion}: ${detail}`,
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

/** True if pub `options` already carry a `--verbose` flag. */
function hasVerbose(options) {
  return options.some((o) => o === "--verbose");
}

/**
 * Run `dart cmd`, echoing combined output live while capturing it.
 *
 * Resolves to `[returncode, combinedOutput]`. Used in verbose mode so the user
 * watches pub in real time (e.g. a slow resolve or a hang) yet the captured
 * text still feeds the JSON report.
 */
function stream(cmd, env, cwd = null) {
  return new Promise((resolve) => {
    const proc = spawn("dart", cmd, { env, cwd: cwd || undefined, stdio: ["ignore", "pipe", "pipe"] });
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
 * Each version is added via `dart pub add <pkg>:<ver>` inside a throwaway
 * temp Dart package, success classified on returncode. Returns the list of
 * result objects. If `firstOnly` is set, stops after the first version that
 * installs successfully. When `verbose` is set, pub's full output is streamed
 * live (and `--verbose` is added if none is present) so install failures can
 * be debugged; the captured output is also folded into the report under
 * `log`/`error`.
 */
export async function testInstallations(pkgDir, pkg, indexUrl, versions, outputJson, {
  firstOnly = false, cfg = null, verbose = false,
} = {}) {
  cfg = cfg || resolveEnv();
  const env = subprocessEnv(cfg);
  const options = pubOptions(cfg);
  const results = [];
  const installable = [];

  for (let idx = 0; idx < versions.length; idx++) {
    const version = versions[idx];
    const target = `${pkg}:${version}`;
    console.log(`[${idx + 1}/${versions.length}] Attempting to install: ${target}...`);

    // A fresh temp package per version keeps `dart pub add` hermetic and
    // avoids one version's constraint pinning the next.
    const tmpPkg = fs.mkdtempSync(path.join(pkgDir, "dart-itest-"));
    dartCreate(tmpPkg, cfg, verbose);

    let cmd = ["pub", "add", target];
    cmd = cmd.concat(options);
    // Bump pub's verbosity if the user wants detail and nothing already set it.
    if (verbose && !hasVerbose(options)) cmd.push("--verbose");

    let returncode, stdoutText, stderrText, signal = null, spawnError = null;
    if (verbose) {
      console.log(`  $ (cd ${tmpPkg} && dart ${cmd.join(" ")})`);
      const [code, output] = await stream(cmd, env, tmpPkg);
      returncode = code;
      stdoutText = stderrText = output; // streamed combined; same text both ways
    } else {
      const res = spawnSync("dart", cmd, {
        encoding: "utf8",
        env,
        cwd: tmpPkg,
        maxBuffer: 50 * 1024 * 1024, // defensive guard against future verbose output
      });
      returncode = res.status;
      stdoutText = res.stdout;
      stderrText = res.stderr;
      signal = res.signal; // set when status is null (child killed by signal)
      spawnError = res.error;
    }

    if (returncode === 0) {
      console.log(`  ✅ SUCCESS: ${target}`);
      results.push({ version, status: "success", log: lastLine(stdoutText) });
      installable.push(version);
    } else {
      console.log(`  ❌ FAILED: ${target}`);
      // A null returncode means the child was killed by a signal (e.g. buffer
      // overflow SIGTERM) — stderr is empty then, so fall back to the signal
      // name / spawn error so the failure isn't recorded blank.
      const error = lastLine(stderrText)
        || (signal && `terminated by signal ${signal}`)
        || (spawnError && spawnError.message)
        || "Unknown error";
      results.push({ version, status: "failed", error });
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

const HELP = `usage: main.mjs [-h] [--hosted-url INDEX_URL] [--package-dir VENV_DIR]
                [--dart-version DART_VERSION] [--output OUTPUT] [--limit LIMIT]
                [--first-only] [-v] package

Find installable versions of a package from a Dart pub registry.

positional arguments:
  package               Package name to probe (e.g. http).

options:
  -h, --help            show this help message and exit
  --hosted-url INDEX_URL
                        Custom pub hosted server URL. Defaults to $PUB_HOSTED_URL,
                        then $DART_REGISTRY_URL, then https://pub.dev.
  --package-dir VENV_DIR
                        Directory for the isolated test Dart package.
                        (default: .dart-test-install)
  --dart-version DART_VERSION
                        dart version to expect in the test package ('none' to skip
                        the check). (default: ${DEFAULT_DART_VERSION})
  --output OUTPUT       Path to write the JSON report.
                        (default: installation_report.json)
  --limit LIMIT         Only test the newest N versions (default: all).
  --first-only          Stop after the first version that installs successfully.
  -v, --verbose         Stream full pub output for every step so failures are
                        debuggable.
`;

/** Parse a `main`-style argv list into an options object (mirrors argparse). */
export function parseArgs(argv = null) {
  argv = argv === null ? process.argv.slice(2) : argv;
  const args = {
    package: null,
    indexUrl: null,
    venvDir: ".dart-test-install",
    dartVersion: DEFAULT_DART_VERSION,
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
    } else if (a === "--hosted-url") {
      args.indexUrl = next();
    } else if (a === "--package-dir") {
      args.venvDir = next();
    } else if (a === "--dart-version") {
      args.dartVersion = next();
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

  console.log(`Found ${versions.length} version(s) to test (registry: ${cfg.DART_REGISTRY_NAME}).`);
  const dartVersion = String(args.dartVersion).toLowerCase() === "none" ? null : args.dartVersion;
  const pkgDir = setupVenv(args.venvDir, dartVersion, cfg, args.verbose);
  await testInstallations(pkgDir, args.package, indexUrl, versions, args.output, {
    firstOnly: args.firstOnly, cfg, verbose: args.verbose,
  });
  return 0;
}

// main() accepts an optional argv list. Pass one explicitly to drive the tool
// programmatically (e.g. from another script or a test); omit it and main()
// falls back to parseArgs(null), which reads from process.argv (normal CLI use).
//
// Example — probe the newest 5 versions of http, stop at the first installable:
//     main(["http", "--hosted-url", "https://pub.dev",
//           "--limit", "5", "--first-only"])
//
// Equivalent on the command line:
//     node main.mjs http \
//         --hosted-url https://pub.dev --limit 5 --first-only

import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then((code) => process.exit(code)); // argv=null -> parseArgs reads process.argv
}
