#!/usr/bin/env node
/**
 * Find installable versions of a package from a (custom) NuGet registry.
 *
 * Discovers every version a registry advertises for a package via the NuGet
 * flat-container API (`/v3-flatcontainer/<id>/index.json`), then attempts to
 * install each one into an isolated throwaway .NET project, recording
 * success/failure per version to a JSON report.
 *
 * Example:
 *     node main.mjs Newtonsoft.Json \
 *         --source https://api.nuget.org/v3/index.json
 *
 *     # only probe the newest 5 versions, stop at the first that installs
 *     node main.mjs Newtonsoft.Json --source https://api.nuget.org/v3/index.json \
 *         --limit 5 --first-only
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// dotnet/nuget tool version the test environment is expected to use by default.
// Install-tests run against this toolchain, so it governs restore/resolver
// behaviour. Override via --dotnet-version (CLI) or the `dotnet` command (REPL).
export const DEFAULT_DOTNET_VERSION = "8.0";

// Environment knobs read via process.env, each falling back to the value the
// .NET / NuGet / TLS ecosystem uses by default ("industry standard"). dotnet
// itself auto-reads NUGET_* / DOTNET_* vars from the environment; we resolve
// them explicitly so the documented default still applies when the var is unset,
// and so they can be surfaced (REPL `env`) and threaded into every dotnet/nuget
// invocation we build.
export const ENV_DEFAULTS = {
  NUGET_VERBOSE: "0",                                  // nuget: quiet (0 = normal)
  NUGET_CERT: "",                                      // nuget: use system store
  NUGET_API: "https://api.nuget.org/v3-flatcontainer",  // flat-container base for listing
  NUGET_SOURCE: "https://api.nuget.org/v3/index.json",  // v3 service index for restore
  NUGET_TRUSTED_HOST: "",                              // nuget: no extra trusted hosts
  NUGET_DEFAULT_TIMEOUT: "15",                         // nuget: 15s socket timeout
  NUGET_RETRIES: "5",                                 // nuget: 5 connection retries
  DOTNET_REGISTRY_URL: "https://api.nuget.org/v3/index.json",  // our source fallback
  DOTNET_REGISTRY_NAME: "NuGet.org",                  // registry display name
  REQUESTS_CA_BUNDLE: "",                             // requests/urllib3: certifi
  SSL_CERT_FILE: "",                                  // OpenSSL: system CA file
  SSL_CERT_DIR: "",                                   // OpenSSL: system CA dir
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

/** Pick the source URL: explicit flag > NUGET_SOURCE > DOTNET_REGISTRY_URL. */
export function resolveIndexUrl(explicit, cfg = null) {
  cfg = cfg || resolveEnv();
  return explicit || cfg.NUGET_SOURCE || cfg.DOTNET_REGISTRY_URL || null;
}

/** Translate resolved config into dotnet/nuget command-line flags. */
export function nugetOptions(cfg) {
  const opts = [];
  let level = parseInt(cfg.NUGET_VERBOSE, 10);
  if (Number.isNaN(level)) level = 0;
  if (level > 0) opts.push("--verbosity", "detailed");  // dotnet: bump restore verbosity
  if (cfg.NUGET_CERT) opts.push("--configfile", cfg.NUGET_CERT);
  // dotnet add/restore has no per-call timeout/retry flags; NuGet reads them
  // from the environment, so they ride along via subprocessEnv. We still keep
  // the resolved values addressable for parity with the reference shape.
  return opts;
}

/** Child-process environment with resolved TLS cert + NuGet vars applied. */
export function subprocessEnv(cfg) {
  const env = { ...process.env };
  for (const name of TLS_ENV_VARS) {
    if (cfg[name]) env[name] = cfg[name];
  }
  // NuGet honours these from the environment; thread the resolved values in.
  env.NUGET_DEFAULT_TIMEOUT = String(cfg.NUGET_DEFAULT_TIMEOUT);
  env.NUGET_RETRIES = String(cfg.NUGET_RETRIES);
  return env;
}

/**
 * Return the list of versions a registry advertises for `pkg`.
 *
 * Versions are returned newest-first. The NuGet flat-container index lists
 * versions oldest-first (`versions[]`), so we reverse it. When `verbose` is set,
 * the API URL and its raw payload are echoed so a failed or empty discovery can
 * be debugged.
 */
export async function getAvailableVersions(pkg, indexUrl, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  console.log(`Retrieving versions for '${pkg}' from ${indexUrl}...`);
  // The flat-container resource keys its index by the lower-cased package id.
  const api = cfg.NUGET_API.replace(/\/+$/, "");
  const url = `${api}/${pkg.toLowerCase()}/index.json`;
  if (verbose) console.log(`  $ GET ${url}`);

  let payload;
  try {
    const resp = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(parseInt(cfg.NUGET_DEFAULT_TIMEOUT, 10) * 1000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    payload = await resp.text();
  } catch (e) {  // fetch raises a zoo of errors; treat all as fatal here
    if (verbose) echo(String(e.message || e));
    console.error(`Error querying NuGet flat-container: ${e.message || e}`);
    process.exit(1);
  }

  if (verbose) echo(payload);
  let data;
  try {
    data = JSON.parse(payload);
  } catch {
    console.error("Could not parse JSON from NuGet flat-container.");
    return [];
  }
  const versions = data.versions;
  if (!versions || !versions.length) {
    console.error("Could not find 'versions' in NuGet flat-container index.");
    return [];
  }
  // API lists oldest-first; reverse so callers get newest-first.
  return versions.map((v) => String(v).trim()).filter((v) => v).reverse();
}

/**
 * Create a fresh throwaway .NET project if needed; return its directory.
 *
 * The sandbox is a `dotnet new classlib` project into which each version is
 * added with `dotnet add package`. `dotnetVersion` records the toolchain the
 * tests are expected to run against (default `DEFAULT_DOTNET_VERSION`). Pass
 * `dotnetVersion=null` to skip the toolchain-check echo. `verbose` echoes the
 * project-scaffold output so a failed setup can be debugged.
 */
export function setupVenv(envDir, dotnetVersion = DEFAULT_DOTNET_VERSION, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  if (!fs.existsSync(envDir)) {
    console.log(`Creating throwaway .NET project at: ${envDir}`);
    fs.mkdirSync(envDir, { recursive: true });
    const cmd = ["new", "classlib", "-o", envDir];
    if (verbose) console.log(`  $ dotnet ${cmd.join(" ")}`);
    const res = spawnSync("dotnet", cmd, { encoding: "utf8", env: subprocessEnv(cfg) });
    if (verbose) echo(res.stdout, res.stderr);
    if (res.status !== 0) {
      console.error(
        `Warning: could not scaffold the .NET project: ` +
        `${lastLine(res.stderr) || "unknown error"}`,
      );
    }
  }

  if (dotnetVersion) ensureDotnetVersion(envDir, dotnetVersion, cfg, verbose);
  return envDir;
}

/** Report the dotnet SDK version (the toolchain install-tests run against). */
function ensureDotnetVersion(envDir, dotnetVersion, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  console.log(`Ensuring dotnet>=${dotnetVersion} in the test environment...`);
  const cmd = ["--version"];
  if (verbose) console.log(`  $ dotnet ${cmd.join(" ")}`);
  const res = spawnSync("dotnet", cmd, { encoding: "utf8", env: subprocessEnv(cfg) });
  if (verbose) echo(res.stdout, res.stderr);
  if (res.status !== 0) {
    console.error(
      `Warning: could not verify dotnet>=${dotnetVersion}: ` +
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

/** True if dotnet `options` already carry a `--verbosity` flag. */
function hasVerbose(options) {
  return options.some((o) => o === "--verbosity");
}

/**
 * Run `dotnet <cmd>`, echoing combined output live while capturing it.
 *
 * Resolves to `[returncode, combined_output]`. Used in verbose mode so the user
 * watches dotnet in real time (e.g. a slow restore or a hang) yet the captured
 * text still feeds the JSON report.
 */
function stream(cmd, env) {
  return new Promise((resolve) => {
    const proc = spawn("dotnet", cmd, { env, stdio: ["ignore", "pipe", "pipe"] });
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
 * first version that installs successfully. When `verbose` is set, dotnet's full
 * output is streamed live (and a `--verbosity detailed` flag is added if none is
 * present) so install failures can be debugged; the captured output is also
 * folded into the report under `log`/`error`.
 */
export async function testInstallations(venvDir, pkg, indexUrl, versions, outputJson, {
  firstOnly = false, cfg = null, verbose = false,
} = {}) {
  cfg = cfg || resolveEnv();
  const env = subprocessEnv(cfg);
  const options = nugetOptions(cfg);
  const results = [];
  const installable = [];

  for (let idx = 0; idx < versions.length; idx++) {
    const version = versions[idx];
    const target = `${pkg}@${version}`;
    console.log(`[${idx + 1}/${versions.length}] Attempting to install: ${target}...`);

    const cmd = [
      "add",
      venvDir,
      "package",
      pkg,
      "--version",
      version,
    ];
    cmd.push(...options);
    if (indexUrl) cmd.push("--source", indexUrl);
    // Bump dotnet's own verbosity if the user wants detail and nothing set it.
    if (verbose && !hasVerbose(options)) cmd.push("--verbosity", "detailed");

    let returncode, stdoutText, stderrText;
    if (verbose) {
      console.log(`  $ dotnet ${cmd.join(" ")}`);
      const [code, output] = await stream(cmd, env);
      returncode = code;
      stdoutText = stderrText = output; // streamed combined; same text both ways
    } else {
      const res = spawnSync("dotnet", cmd, { encoding: "utf8", env });
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
        version, status: "failed",
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
                [--dotnet-version DOTNET_VERSION] [--output OUTPUT] [--limit LIMIT]
                [--first-only] [-v] package

Find installable versions of a package from a NuGet registry.

positional arguments:
  package               Package id to probe (e.g. Newtonsoft.Json).

options:
  -h, --help            show this help message and exit
  --source SOURCE       Custom NuGet v3 service index URL. Defaults to
                        $NUGET_SOURCE, then $DOTNET_REGISTRY_URL, then
                        https://api.nuget.org/v3/index.json.
  --venv-dir VENV_DIR   Directory for the isolated throwaway .NET test project.
                        (default: .venv-test-install)
  --dotnet-version DOTNET_VERSION
                        dotnet SDK version expected in the test env ('none' to
                        skip the check). (default: ${DEFAULT_DOTNET_VERSION})
  --output OUTPUT       Path to write the JSON report.
                        (default: installation_report.json)
  --limit LIMIT         Only test the newest N versions (default: all).
  --first-only          Stop after the first version that installs successfully.
  -v, --verbose         Stream full dotnet output for every step so failures are
                        debuggable.
`;

/** Parse a `main`-style argv list into an options object (mirrors argparse). */
export function parseArgs(argv = null) {
  argv = argv === null ? process.argv.slice(2) : argv;
  const args = {
    package: null,
    source: null,
    venvDir: ".venv-test-install",
    dotnetVersion: DEFAULT_DOTNET_VERSION,
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
    } else if (a === "--dotnet-version") {
      args.dotnetVersion = next();
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

  console.log(`Found ${versions.length} version(s) to test (registry: ${cfg.DOTNET_REGISTRY_NAME}).`);
  const dotnetVersion = String(args.dotnetVersion).toLowerCase() === "none" ? null : args.dotnetVersion;
  const venvDir = setupVenv(args.venvDir, dotnetVersion, cfg, args.verbose);
  await testInstallations(venvDir, args.package, indexUrl, versions, args.output, {
    firstOnly: args.firstOnly, cfg, verbose: args.verbose,
  });
  return 0;
}

// main() accepts an optional argv list. Pass one explicitly to drive the tool
// programmatically (e.g. from another script or a test); omit it and main()
// falls back to parseArgs(null), which reads from process.argv (normal CLI use).
//
// Example — probe the newest 5 versions of Newtonsoft.Json, stop at the first
// installable:
//     main(["Newtonsoft.Json", "--source", "https://api.nuget.org/v3/index.json",
//           "--limit", "5", "--first-only"])
//
// Equivalent on the command line:
//     node main.mjs Newtonsoft.Json \
//         --source https://api.nuget.org/v3/index.json --limit 5 --first-only

import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then((code) => process.exit(code)); // argv=null -> parseArgs reads process.argv
}
