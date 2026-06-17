#!/usr/bin/env node
/**
 * Find installable versions of a package from a (custom) Stackage/Hackage registry.
 *
 * Discovers every version Hackage advertises for a package via its HTTP JSON
 * endpoint (`https://hackage.haskell.org/package/<pkg>.json`, a
 * version->preference map), then attempts to resolve each one as a Stack
 * `extra-deps` pin inside a throwaway project (`stack build --dry-run`),
 * recording success/failure per version to a JSON report.
 *
 * Example:
 *     node main.mjs aeson \
 *         --index-url https://hackage.haskell.org
 *
 *     # only probe the newest 5 versions, stop at the first that resolves
 *     node main.mjs aeson --index-url https://hackage.haskell.org \
 *         --limit 5 --first-only
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// stack tool version the test environment expects by default. Resolve-tests run
// against this stack, so it governs resolver/snapshot behaviour. Override via
// --stack-version (CLI) or the `stack` command (REPL). stack is not pinnable the
// way pip is, so this is advisory: we surface it and warn on a mismatch.
export const DEFAULT_STACK_VERSION = "3.1.1";

// Environment knobs read via process.env, each falling back to the value the
// Haskell / Stack / TLS ecosystem uses by default ("industry standard"). stack
// reads a handful of vars from the environment; we resolve them explicitly so
// the documented default still applies when the var is unset, and so they can be
// surfaced (REPL `env`) and threaded into every stack invocation we build.
export const ENV_DEFAULTS = {
  STACK_VERBOSE: "0",                              // stack: quiet (0 = no --verbose)
  STACK_CERT: "",                                  // stack: use system CA store
  HACKAGE_API_URL: "https://hackage.haskell.org",  // Hackage JSON/page base
  STACK_RESOLVER: "lts",                           // stack: snapshot resolver
  STACK_INSECURE: "0",                             // stack: keep TLS verification
  STACK_HTTP_TIMEOUT: "15",                        // advisory: 15s socket timeout
  STACK_HTTP_RETRIES: "5",                         // advisory: fetch retries
  STACK_REGISTRY_URL: "https://hackage.haskell.org",  // our index-url fallback
  STACK_REGISTRY_NAME: "Stackage/Hackage",         // registry display name
  REQUESTS_CA_BUNDLE: "",                          // urllib: certifi CA bundle
  SSL_CERT_FILE: "",                               // OpenSSL: system CA file
  SSL_CERT_DIR: "",                                // OpenSSL: system CA dir
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

/** Pick the index URL: explicit flag > STACK_REGISTRY_URL > HACKAGE_API_URL. */
export function resolveIndexUrl(explicit, cfg = null) {
  cfg = cfg || resolveEnv();
  return explicit || cfg.STACK_REGISTRY_URL || cfg.HACKAGE_API_URL || null;
}

/** Translate resolved config into stack command-line flags. */
export function stackOptions(cfg) {
  const opts = [];
  let level;
  const parsed = parseInt(cfg.STACK_VERBOSE, 10);
  level = Number.isNaN(parsed) ? 0 : parsed;
  if (level > 0) opts.push("--verbose"); // stack: chatty resolver output
  if (cfg.STACK_INSECURE && cfg.STACK_INSECURE !== "0") opts.push("--no-check-cert");
  return opts;
}

/** Child-process environment with resolved stack/TLS vars applied. */
export function subprocessEnv(cfg) {
  const env = { ...process.env };
  for (const name of TLS_ENV_VARS) {
    if (cfg[name]) env[name] = cfg[name];
  }
  if (cfg.STACK_CERT) env.SSL_CERT_FILE = cfg.STACK_CERT;
  return env;
}

/** Derive the Hackage base URL from the index URL or HACKAGE_API_URL. */
function apiBase(indexUrl, cfg) {
  if (indexUrl) return indexUrl.replace(/\/+$/, "");
  return cfg.HACKAGE_API_URL.replace(/\/+$/, "");
}

/**
 * Return the list of versions Hackage advertises for `package`.
 *
 * Stack resolves packages from Hackage, so discovery uses Hackage's JSON
 * endpoint (`/package/<pkg>.json`), a `{version: preference}` map. We sort
 * the keys descending by their numeric components so the list comes back
 * newest-first. When `verbose` is set, the URL and raw output are echoed so
 * a failed or empty discovery can be debugged.
 */
export async function getAvailableVersions(pkg, indexUrl, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  console.log(`Retrieving versions for '${pkg}' from ${indexUrl}...`);
  const base = apiBase(indexUrl, cfg);
  const url = `${base}/package/${pkg}.json`;
  if (verbose) console.log(`  $ GET ${url}`);

  let payload;
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    payload = await res.text();
  } catch (e) {
    console.error(`Error querying Hackage: ${e.message || e}`);
    return [];
  }

  if (verbose) echo(payload);
  let versions;
  try {
    const data = JSON.parse(payload);
    // The JSON endpoint is a {version: "normal"/"unpreferred"/...} map; the
    // keys are the versions. Sort newest-first by numeric version tuple.
    versions = Object.keys(data).sort((a, b) => compareVersionKey(versionKey(b), versionKey(a)));
  } catch (e) {
    console.error(`Could not parse Hackage JSON: ${e.message || e}`);
    return [];
  }
  if (!versions.length) {
    console.error("No versions in Hackage response.");
  }
  return versions;
}

/** Return a sortable array of numeric components for a version string. */
function versionKey(ver) {
  return ver.split(/[.\-]/).map((p) => (/^\d+$/.test(p) ? parseInt(p, 10) : 0));
}

/** Compare two version-key arrays element-wise (like Python tuple compare). */
function compareVersionKey(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

/**
 * Create a fresh scratch project directory if needed; return its path.
 *
 * Stack has no per-project virtualenv: the isolated sandbox is a throwaway
 * project dir into which each probe writes a stack.yaml + package.yaml pinning
 * one `extra-dep`. The directory is created lazily and reused.
 * `stackVersion` is advisory (stack is not pinnable like pip); pass
 * `stackVersion=null` to skip the version check. `verbose` echoes the
 * version probe so a mismatch can be debugged.
 */
export function setupVenv(envDir, stackVersion = DEFAULT_STACK_VERSION, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  if (!fs.existsSync(envDir)) {
    console.log(`Creating resolve sandbox at: ${envDir}`);
    fs.mkdirSync(envDir, { recursive: true });
  }

  if (stackVersion) ensureStackVersion(stackVersion, cfg, verbose);
  // The "handle" the test step needs is just the sandbox directory.
  return envDir;
}

/** Check the installed stack against `stackVersion` (advisory only). */
function ensureStackVersion(stackVersion, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  console.log(`Ensuring stack==${stackVersion} in the test environment...`);
  const cmd = ["--version"];
  if (verbose) console.log(`  $ stack ${cmd.join(" ")}`);
  const res = spawnSync("stack", cmd, { encoding: "utf8", env: subprocessEnv(cfg) });
  if (verbose) echo(res.stdout, res.stderr);
  if (res.status !== 0) {
    console.error(
      `Warning: could not verify stack==${stackVersion}: ${lastLine(res.stderr) || "stack not found"}`,
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

/** True if stack `options` already carry a `--verbose` flag. */
function hasVerbose(options) {
  return options.some((o) => o.startsWith("--verbose"));
}

/**
 * Run `stack <cmd>`, echoing combined output live while capturing it.
 *
 * Resolves to `[returncode, combinedOutput]`. Used in verbose mode so the user
 * watches stack in real time (e.g. a slow resolve or a hang) yet the captured
 * text still feeds the JSON report.
 */
function stream(cmd, env, cwd = null) {
  return new Promise((resolve) => {
    const proc = spawn("stack", cmd, { env, cwd: cwd || undefined, stdio: ["ignore", "pipe", "pipe"] });
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
 * Write a minimal stack project pinning `package-version` as an extra-dep.
 *
 * A throwaway library package with a single `extra-deps` entry is the
 * smallest unit Stack will resolve; `stack build --dry-run` then exercises
 * the whole dependency graph without compiling anything.
 */
function writeProject(projectDir, pkg, version, cfg) {
  fs.mkdirSync(projectDir, { recursive: true });
  const resolver = cfg.STACK_RESOLVER || "lts";
  // stack.yaml: snapshot resolver + the single version pin under extra-deps.
  let stackYaml = "";
  stackYaml += `resolver: ${resolver}\n`;
  stackYaml += "packages:\n  - .\n";
  stackYaml += "extra-deps:\n";
  stackYaml += `  - ${pkg}-${version}\n`;
  fs.writeFileSync(path.join(projectDir, "stack.yaml"), stackYaml);
  // package.yaml: a trivial library that depends on the pinned package.
  let pkgYaml = "";
  pkgYaml += "name: probe\nversion: 0.0.0\n";
  pkgYaml += "library:\n  dependencies:\n    - base\n";
  pkgYaml += `    - ${pkg}\n`;
  fs.writeFileSync(path.join(projectDir, "package.yaml"), pkgYaml);
}

/**
 * Attempt to resolve each version; write an incremental JSON report.
 *
 * Returns the list of result objects. If `firstOnly` is set, stops after the
 * first version that resolves successfully. When `verbose` is set, stack's
 * full output is streamed live (and a `--verbose` flag is added if none is
 * present) so resolve failures can be debugged; the captured output is also
 * folded into the report under `log`/`error`.
 */
export async function testInstallations(envDir, pkg, indexUrl, versions, outputJson, {
  firstOnly = false, cfg = null, verbose = false,
} = {}) {
  cfg = cfg || resolveEnv();
  const env = subprocessEnv(cfg);
  const options = stackOptions(cfg);
  const results = [];
  const installable = [];

  for (let idx = 0; idx < versions.length; idx++) {
    const version = versions[idx];
    const target = `${pkg}-${version}`;
    console.log(`[${idx + 1}/${versions.length}] Attempting to resolve: ${target}...`);

    // Each version gets its own throwaway project so resolves never clobber
    // one another and the sandbox stays inspectable on failure.
    const projectDir = path.join(envDir, target);
    writeProject(projectDir, pkg, version, cfg);
    const cmd = ["build", "--dry-run", ...options];
    // Bump stack's own verbosity if the user wants detail and nothing set it.
    if (verbose && !hasVerbose(options)) cmd.push("--verbose");

    let returncode, stdoutText, stderrText;
    if (verbose) {
      console.log(`  $ (cd ${projectDir} && stack ${cmd.join(" ")})`);
      const [code, output] = await stream(cmd, env, projectDir);
      returncode = code;
      stdoutText = stderrText = output; // streamed combined; same text both ways
    } else {
      const res = spawnSync("stack", cmd, { encoding: "utf8", env, cwd: projectDir });
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
                [--stack-version STACK_VERSION] [--output OUTPUT] [--limit LIMIT]
                [--first-only] [-v] package

Find installable versions of a package from a Stackage/Hackage registry.

positional arguments:
  package               Package name to probe (e.g. aeson).

options:
  -h, --help            show this help message and exit
  --index-url INDEX_URL
                        Custom Hackage registry URL. Defaults to $STACK_REGISTRY_URL,
                        then $HACKAGE_API_URL, then https://hackage.haskell.org.
  --venv-dir VENV_DIR   Directory for the isolated resolve sandbox.
                        (default: .stack-test-resolve)
  --stack-version STACK_VERSION
                        stack version expected in the test sandbox ('none' to skip
                        the check). (default: ${DEFAULT_STACK_VERSION})
  --output OUTPUT       Path to write the JSON report.
                        (default: installation_report.json)
  --limit LIMIT         Only test the newest N versions (default: all).
  --first-only          Stop after the first version that resolves successfully.
  -v, --verbose         Stream full stack output for every step so failures are
                        debuggable.
`;

/** Parse a `main`-style argv list into an options object (mirrors argparse). */
export function parseArgs(argv = null) {
  argv = argv === null ? process.argv.slice(2) : argv;
  const args = {
    package: null,
    indexUrl: null,
    venvDir: ".stack-test-resolve",
    stackVersion: DEFAULT_STACK_VERSION,
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
    } else if (a === "--stack-version") {
      args.stackVersion = next();
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

  console.log(`Found ${versions.length} version(s) to test (registry: ${cfg.STACK_REGISTRY_NAME}).`);
  const stackVersion = String(args.stackVersion).toLowerCase() === "none" ? null : args.stackVersion;
  const envDir = setupVenv(args.venvDir, stackVersion, cfg, args.verbose);
  await testInstallations(envDir, args.package, indexUrl, versions, args.output, {
    firstOnly: args.firstOnly, cfg, verbose: args.verbose,
  });
  return 0;
}

// main() accepts an optional argv list. Pass one explicitly to drive the tool
// programmatically (e.g. from another script or a test); omit it and main()
// falls back to parseArgs(null), which reads from process.argv (normal CLI use).
//
// Example — probe the newest 5 versions of aeson, stop at the first resolvable:
//     main(["aeson", "--index-url", "https://hackage.haskell.org",
//           "--limit", "5", "--first-only"])
//
// Equivalent on the command line:
//     node main.mjs aeson \
//         --index-url https://hackage.haskell.org --limit 5 --first-only

import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then((code) => process.exit(code)); // argv=null -> parseArgs reads process.argv
}
