#!/usr/bin/env node
/**
 * Find installable versions of a package from a (custom) Chocolatey registry.
 *
 * Discovers every version a registry advertises for a package via the Chocolatey
 * community feed's NuGet v2 OData endpoint (`/FindPackagesById()?id='<id>'`),
 * then attempts to install each one with `choco install` into an isolated
 * throwaway cache directory, recording success/failure per version to a JSON
 * report.
 *
 * IMPORTANT — platform note: `choco` itself is **Windows-only**. The HTTP
 * version-listing (the `versions` command) queries the community feed over
 * plain HTTP and therefore works on any OS. The install-test step shells out to
 * `choco install`, which requires Windows with `choco` on PATH; on a
 * non-Windows host that subprocess simply fails (the listing still works fine).
 *
 * Example:
 *     node main.mjs git \
 *         --source https://community.chocolatey.org/api/v2/
 *
 *     # only probe the newest 5 versions, stop at the first that installs
 *     node main.mjs git --source https://community.chocolatey.org/api/v2/ \
 *         --limit 5 --first-only
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// choco tool version the test environment is expected to use by default.
// Install-tests run against this toolchain, so it governs install/resolver
// behaviour. Override via --choco-version (CLI) or the `choco` command (REPL).
export const DEFAULT_CHOCO_VERSION = "2.3.0";

// Environment knobs read via process.env, each falling back to the value the
// Chocolatey / NuGet / TLS ecosystem uses by default ("industry standard").
// choco itself reads some of these from the environment; we resolve them
// explicitly so the documented default still applies when the var is unset, and
// so they can be surfaced (REPL `env`) and threaded into every choco invocation
// we build.
export const ENV_DEFAULTS = {
  CHOCO_VERBOSE: "0",                                          // choco: quiet (0 = normal)
  CHOCO_CERT: "",                                              // choco: use system store
  CHOCO_API: "https://community.chocolatey.org/api/v2",        // NuGet v2 feed base for listing
  CHOCO_SOURCE: "https://community.chocolatey.org/api/v2/",    // source for install
  CHOCO_TRUSTED_HOST: "",                                      // choco: no extra trusted hosts
  CHOCO_DEFAULT_TIMEOUT: "15",                                 // choco: 15s socket timeout
  CHOCO_RETRIES: "5",                                          // choco: 5 connection retries
  CHOCO_REGISTRY_URL: "https://community.chocolatey.org/api/v2/",  // our source fallback
  CHOCO_REGISTRY_NAME: "Chocolatey Community",                 // registry display name
  REQUESTS_CA_BUNDLE: "",                                      // requests/urllib3: certifi
  SSL_CERT_FILE: "",                                           // OpenSSL: system CA file
  SSL_CERT_DIR: "",                                            // OpenSSL: system CA dir
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

/** Pick the source URL: explicit flag > CHOCO_SOURCE > CHOCO_REGISTRY_URL. */
export function resolveIndexUrl(explicit, cfg = null) {
  cfg = cfg || resolveEnv();
  return explicit || cfg.CHOCO_SOURCE || cfg.CHOCO_REGISTRY_URL || null;
}

/** Translate resolved config into choco command-line flags. */
export function chocoOptions(cfg) {
  const opts = [];
  let level;
  try {
    level = parseInt(cfg.CHOCO_VERBOSE, 10);
    if (Number.isNaN(level)) level = 0;
  } catch {
    level = 0;
  }
  if (level > 0) opts.push("--verbose"); // choco: bump install verbosity
  if (cfg.CHOCO_CERT) {
    // choco reads a client cert via config, not a per-call flag; keep this a
    // no-op mirroring the reference shape so the resolved value stays
    // addressable without changing behaviour.
  }
  // choco install has an --execution-timeout flag; NuGet-style retries are read
  // from the environment, so they ride along via subprocessEnv. We still keep
  // the resolved values addressable for parity with the reference shape.
  return opts;
}

/** Child-process environment with resolved TLS cert + Choco vars applied. */
export function subprocessEnv(cfg) {
  const env = { ...process.env };
  for (const name of TLS_ENV_VARS) {
    if (cfg[name]) env[name] = cfg[name];
  }
  // choco honours these from the environment; thread the resolved values in.
  env.CHOCO_DEFAULT_TIMEOUT = String(cfg.CHOCO_DEFAULT_TIMEOUT);
  env.CHOCO_RETRIES = String(cfg.CHOCO_RETRIES);
  return env;
}

/**
 * Return the list of versions a registry advertises for `pkg`.
 *
 * Versions are returned newest-first. The Chocolatey community feed is a NuGet
 * v2 OData feed: `FindPackagesById()?id='<pkg>'` returns an ATOM/XML document
 * whose `<entry>` elements each carry a `<m:properties><d:Version>` value
 * (namespaces `m` = `.../metadata` and `d` = `.../dataservices`). We collect the
 * text of every element whose localname is `Version`, namespace-agnostically.
 * The feed is typically oldest-first, so we sort descending if possible, else
 * reverse the feed order. When `verbose` is set, the API URL and its raw payload
 * are echoed so a failed or empty discovery can be debugged.
 *
 * Note: this listing is plain HTTP and works on any OS; the *install-test* step
 * below requires Windows with `choco` on PATH.
 */
export async function getAvailableVersions(pkg, indexUrl, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  console.log(`Retrieving versions for '${pkg}' from ${indexUrl}...`);
  // The v2 OData feed keys its lookup by the package id passed as a quoted
  // string literal inside FindPackagesById().
  const api = cfg.CHOCO_API.replace(/\/+$/, "");
  const url = `${api}/FindPackagesById()?id='${pkg}'`;
  if (verbose) console.log(`  $ GET ${url}`);

  let payload;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      parseInt(cfg.CHOCO_DEFAULT_TIMEOUT, 10) * 1000,
    );
    try {
      const resp = await fetch(url, {
        headers: { Accept: "application/atom+xml" },
        signal: controller.signal,
      });
      payload = await resp.text();
    } finally {
      clearTimeout(timeout);
    }
  } catch (e) { // fetch raises a zoo of errors; treat all as fatal here
    if (verbose) echo(String(e));
    console.error(`Error querying Chocolatey v2 feed: ${e}`);
    process.exit(1);
  }

  if (verbose) echo(payload);
  // Namespace-agnostic walk: collect the text of any element whose localname
  // (the part after a `{namespace}`/prefix) is exactly 'Version'. Node has no
  // stdlib XML parser, so we match `<...:Version>...</...:Version>` (or
  // unprefixed `<Version>`) with a RegExp over the ATOM/XML payload.
  const versions = [];
  const re = /<(?:[A-Za-z0-9_]+:)?Version[^>]*>([^<]*)<\/(?:[A-Za-z0-9_]+:)?Version>/g;
  let m;
  while ((m = re.exec(payload)) !== null) {
    const text = m[1].trim();
    if (text) versions.push(text);
  }
  if (!versions.length) {
    console.error("Could not find any versions in Chocolatey v2 feed.");
    return [];
  }

  // Feed is typically oldest-first. Prefer a descending numeric-aware sort so
  // callers get newest-first; fall back to simply reversing the feed order if
  // the versions don't sort cleanly.
  const key = (v) => v.split(/[.\-]/).map((p) => (/^\d+$/.test(p) ? parseInt(p, 10) : p));
  try {
    const unique = [...new Set(versions)];
    unique.sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
        const x = ka[i];
        const y = kb[i];
        if (x === undefined) return -1;
        if (y === undefined) return 1;
        if (typeof x !== typeof y) throw new TypeError("uncomparable version parts");
        if (x < y) return -1;
        if (x > y) return 1;
      }
      return 0;
    });
    return unique.reverse(); // descending (newest-first)
  } catch {
    return [...versions].reverse();
  }
}

/**
 * Create a fresh throwaway choco cache/output dir if needed; return it.
 *
 * The sandbox is a temp directory used as choco's `--cache-location` / output
 * dir into which each version is installed with `choco install`. `chocoVersion`
 * records the toolchain the tests are expected to run against (default
 * `DEFAULT_CHOCO_VERSION`). Pass `chocoVersion=null` to skip the toolchain-check
 * echo. `verbose` echoes the setup output so a failed setup can be debugged.
 */
export function setupVenv(envDir, chocoVersion = DEFAULT_CHOCO_VERSION, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  if (!fs.existsSync(envDir)) {
    console.log(`Creating throwaway choco cache dir at: ${envDir}`);
  }
  fs.mkdirSync(envDir, { recursive: true });

  if (chocoVersion) ensureChocoVersion(envDir, chocoVersion, cfg, verbose);
  return envDir;
}

/** Report the choco version (the toolchain install-tests run against). */
function ensureChocoVersion(envDir, chocoVersion, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  console.log(`Ensuring choco>=${chocoVersion} in the test environment...`);
  const cmd = ["--version"];
  if (verbose) console.log(`  $ choco ${cmd.join(" ")}`);
  const res = spawnSync("choco", cmd, { encoding: "utf8", env: subprocessEnv(cfg) });
  if (res.error && res.error.code === "ENOENT") {
    // choco is Windows-only; on other hosts it is simply not on PATH.
    console.error(`Warning: could not verify choco>=${chocoVersion}: ${res.error.message}`);
    return;
  }
  if (verbose) echo(res.stdout, res.stderr);
  if (res.status !== 0) {
    console.error(
      `Warning: could not verify choco>=${chocoVersion}: `
      + `${lastLine(res.stderr) || "unknown error"}`,
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

/** True if choco `options` already carry a `--verbose` flag. */
function hasVerbose(options) {
  return options.some((o) => o === "--verbose");
}

/**
 * Run `cmd`, echoing combined output live while capturing it.
 *
 * Resolves to `[returncode, combinedOutput]`. Used in verbose mode so the user
 * watches choco in real time (e.g. a slow install or a hang) yet the captured
 * text still feeds the JSON report.
 */
function stream(cmd, env) {
  return new Promise((resolve) => {
    const proc = spawn("choco", cmd, { env, stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    const onData = (buf) => {
      const text = buf.toString();
      process.stdout.write(text);
      chunks.push(text);
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("error", (err) => resolve([1, String(err)]));
    proc.on("close", (code) => resolve([code ?? 0, chunks.join("")]));
  });
}

/**
 * Attempt to install each version; write an incremental JSON report.
 *
 * Returns the list of result objects. If `firstOnly` is set, stops after the
 * first version that installs successfully. When `verbose` is set, choco's full
 * output is streamed live (and a `--verbose` flag is added if none is present)
 * so install failures can be debugged; the captured output is also folded into
 * the report under `log`/`error`.
 *
 * IMPORTANT: choco is Windows-only and modifies the system — this performs a
 * *real* `choco install`. On non-Windows hosts choco is unavailable and these
 * tests will fail at the subprocess level (an ENOENT is caught and recorded as
 * a failed result). The HTTP listing above still works cross-platform.
 */
export async function testInstallations(venvDir, pkg, indexUrl, versions, outputJson, {
  firstOnly = false, cfg = null, verbose = false,
} = {}) {
  cfg = cfg || resolveEnv();
  const env = subprocessEnv(cfg);
  const options = chocoOptions(cfg);
  const results = [];
  const installable = [];

  for (let idx = 0; idx < versions.length; idx++) {
    const version = versions[idx];
    const target = `${pkg}@${version}`;
    console.log(`[${idx + 1}/${versions.length}] Attempting to install: ${target}...`);

    let cmd = [
      "install",
      pkg,
      "--version",
      version,
      "-y",
      "--no-progress",
      "--cache-location",
      venvDir,
      ...options,
    ];
    if (indexUrl) cmd = [...cmd, "--source", indexUrl];
    // Bump choco's own verbosity if the user wants detail and nothing set it.
    if (verbose && !hasVerbose(options)) cmd.push("--verbose");

    let returncode, stdoutText, stderrText;
    if (verbose) {
      console.log(`  $ choco ${cmd.join(" ")}`);
      const [code, output] = await stream(cmd, env);
      returncode = code;
      stdoutText = stderrText = output; // streamed combined; same text both ways
    } else {
      const res = spawnSync("choco", cmd, { encoding: "utf8", env });
      if (res.error && res.error.code === "ENOENT") {
        // choco not on PATH (e.g. non-Windows host). Record and continue.
        returncode = 1;
        stdoutText = "";
        stderrText = res.error.message;
      } else {
        returncode = res.status;
        stdoutText = res.stdout;
        stderrText = res.stderr;
      }
    }

    if (returncode === 0) {
      console.log(`  ✅ SUCCESS: ${target}`);
      results.push({
        version,
        status: "success",
        log: lastLine(stdoutText),
      });
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
                [--choco-version CHOCO_VERSION] [--output OUTPUT] [--limit LIMIT]
                [--first-only] [-v] package

Find installable versions of a package from a Chocolatey registry.

positional arguments:
  package               Package id to probe (e.g. git).

options:
  -h, --help            show this help message and exit
  --source SOURCE       Custom Chocolatey source URL. Defaults to $CHOCO_SOURCE,
                        then $CHOCO_REGISTRY_URL, then
                        https://community.chocolatey.org/api/v2/.
  --venv-dir VENV_DIR   Directory for the isolated throwaway choco cache/output.
                        (default: .venv-test-install)
  --choco-version CHOCO_VERSION
                        choco version expected in the test env ('none' to skip
                        the check). (default: ${DEFAULT_CHOCO_VERSION})
  --output OUTPUT       Path to write the JSON report.
                        (default: installation_report.json)
  --limit LIMIT         Only test the newest N versions (default: all).
  --first-only          Stop after the first version that installs successfully.
  -v, --verbose         Stream full choco output for every step so failures are
                        debuggable.
`;

/** Parse a `main`-style argv list into an options object (mirrors argparse). */
export function parseArgs(argv = null) {
  argv = argv === null ? process.argv.slice(2) : argv;
  const args = {
    package: null,
    source: null,
    venvDir: ".venv-test-install",
    chocoVersion: DEFAULT_CHOCO_VERSION,
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
    } else if (a === "--choco-version") {
      args.chocoVersion = next();
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

  let versions = await getAvailableVersions(args.package, indexUrl, cfg, args.verbose);
  if (!versions.length) {
    console.log("No versions found. Exiting.");
    return 1;
  }

  if (args.limit !== null && !Number.isNaN(args.limit)) {
    versions = versions.slice(0, args.limit);
  }

  console.log(`Found ${versions.length} version(s) to test (registry: ${cfg.CHOCO_REGISTRY_NAME}).`);
  const chocoVersion = String(args.chocoVersion).toLowerCase() === "none" ? null : args.chocoVersion;
  const venvDir = setupVenv(args.venvDir, chocoVersion, cfg, args.verbose);
  await testInstallations(venvDir, args.package, indexUrl, versions, args.output, {
    firstOnly: args.firstOnly, cfg, verbose: args.verbose,
  });
  return 0;
}

// main() accepts an optional argv list. Pass one explicitly to drive the tool
// programmatically (e.g. from another script or a test); omit it and main()
// falls back to parseArgs(null), which reads from process.argv (normal CLI use).
//
// Example — probe the newest 5 versions of git, stop at the first installable:
//     main(["git", "--source", "https://community.chocolatey.org/api/v2/",
//           "--limit", "5", "--first-only"])
//
// Equivalent on the command line:
//     node main.mjs git \
//         --source https://community.chocolatey.org/api/v2/ --limit 5 --first-only

import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then((code) => process.exit(code)); // argv=null -> parseArgs reads process.argv
}
