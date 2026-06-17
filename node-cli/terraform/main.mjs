#!/usr/bin/env node
/**
 * Find installable versions of a provider from a (custom) Terraform registry.
 *
 * Discovers every version a registry advertises for a provider via the registry
 * `/v1/providers/<ns>/<name>/versions` API, then attempts to `terraform init`
 * each one in an isolated temp configuration, recording success/failure per
 * version to a JSON report.
 *
 * Example:
 *     node main.mjs hashicorp/aws \
 *         --registry registry.terraform.io
 *
 *     # only probe the newest 5 versions, stop at the first that initialises
 *     node main.mjs hashicorp/aws --registry registry.terraform.io \
 *         --limit 5 --first-only
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// terraform version the test environment is pinned to by default. Init-tests run
// against this terraform, so it governs provider-resolution behaviour. This is a
// soft pin (we only warn if terraform reports a different version) since the
// terraform binary is host-provided, not bootstrapped. Override via
// --terraform-version (CLI) or the `terraform` command (REPL).
export const DEFAULT_TERRAFORM_VERSION = "1.9.8";

// Environment knobs read via process.env, each falling back to the value the
// Terraform ecosystem uses by default ("industry standard"). terraform itself
// auto-reads TF_* vars from the environment; we resolve them explicitly so the
// documented default still applies when the var is unset, and so they can be
// surfaced (REPL `env`) and threaded into every terraform invocation we build.
export const ENV_DEFAULTS = {
  TF_VERBOSE: "0",                                  // our: quiet (0 = no TF_LOG)
  TF_CLI_CONFIG_FILE: "",                           // terraform: CLI config (.terraformrc)
  TF_PLUGIN_CACHE_DIR: "",                          // terraform: provider plugin cache
  TF_REGISTRY: "registry.terraform.io",             // provider registry host for listing
  TF_DEFAULT_TIMEOUT: "15",                         // our: 15s HTTP timeout
  TF_RETRIES: "5",                                  // our: 5 connection retries
  PROVIDER_REGISTRY_URL: "registry.terraform.io",   // our registry-host fallback
  PROVIDER_REGISTRY_NAME: "Terraform Registry",     // registry display name
  REQUESTS_CA_BUNDLE: "",                           // requests/urllib3: certifi
  SSL_CERT_FILE: "",                                // OpenSSL: system CA file
  SSL_CERT_DIR: "",                                 // OpenSSL: system CA dir
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

/** Pick the registry host: explicit flag > TF_REGISTRY > PROVIDER_REGISTRY_URL. */
export function resolveIndexUrl(explicit, cfg = null) {
  cfg = cfg || resolveEnv();
  return explicit || cfg.TF_REGISTRY || cfg.PROVIDER_REGISTRY_URL || null;
}

/** Translate resolved config into terraform command-line flags. */
export function terraformOptions(cfg) {
  const opts = [];
  // terraform has no global verbosity flag (TF_LOG env var instead), but the
  // init step takes -no-color which we always pass for clean captured output.
  opts.push("-no-color");
  return opts;
}

/** Child-process environment with resolved TLS cert vars (and TF_LOG) applied. */
export function subprocessEnv(cfg) {
  const env = { ...process.env };
  for (const name of TLS_ENV_VARS) {
    if (cfg[name]) env[name] = cfg[name];
  }
  if (cfg.TF_CLI_CONFIG_FILE) env.TF_CLI_CONFIG_FILE = cfg.TF_CLI_CONFIG_FILE;
  if (cfg.TF_PLUGIN_CACHE_DIR) env.TF_PLUGIN_CACHE_DIR = cfg.TF_PLUGIN_CACHE_DIR;
  let level;
  const parsed = parseInt(cfg.TF_VERBOSE, 10);
  level = Number.isNaN(parsed) ? 0 : parsed;
  if (level > 0) env.TF_LOG = "DEBUG"; // terraform: verbose provider/registry logs
  return env;
}

/**
 * GET `url` and parse a JSON body via global fetch (no third-party deps).
 *
 * Returns the decoded JSON object, or `null` on any HTTP/parse error (the
 * caller degrades gracefully). `verbose` echoes the request and any error.
 */
async function httpGetJson(url, cfg, headers = null, verbose = false) {
  let timeout;
  const parsed = parseInt(cfg.TF_DEFAULT_TIMEOUT, 10);
  timeout = Number.isNaN(parsed) ? 15 : parsed;
  if (verbose) console.log(`  $ GET ${url}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout * 1000);
  try {
    const resp = await fetch(url, { headers: headers || {}, signal: controller.signal });
    const text = await resp.text();
    return JSON.parse(text);
  } catch (e) {
    if (verbose) console.log(`  ! ${e.message || e}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Return the list of versions a registry advertises for `package`.
 *
 * `package` is a `<namespace>/<name>` provider source address. Versions are
 * returned newest-first; the registry `versions` endpoint lists oldest-first,
 * so we reverse it. When `verbose` is set, the request and raw response are
 * echoed so a failed or empty discovery can be debugged.
 */
export async function getAvailableVersions(pkg, indexUrl, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  console.log(`Retrieving versions for '${pkg}' from ${indexUrl}...`);
  const url = `https://${indexUrl}/v1/providers/${pkg}/versions`;
  const data = await httpGetJson(url, cfg, null, verbose);
  if (!data || !Array.isArray(data.versions)) {
    console.error("Could not find 'versions' in registry response.");
    return [];
  }
  const versions = data.versions.filter((v) => v && v.version).map((v) => v.version);
  return versions.reverse(); // API is oldest-first; we want newest-first
}

/**
 * Create a fresh sandbox directory if needed; return its path.
 *
 * For terraform the "sandbox" is a scratch working directory that each
 * init-test writes a temp `main.tf` into (and where `.terraform` plugins
 * land). The terraform binary is pinned to `terraformVersion` (default
 * `DEFAULT_TERRAFORM_VERSION`) as a *soft* check — we warn on mismatch rather
 * than bootstrap a binary. Pass `terraformVersion=null` to skip the check.
 * `verbose` echoes the version output so a failed check can be debugged.
 */
export function setupVenv(envDir, terraformVersion = DEFAULT_TERRAFORM_VERSION, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  if (!fs.existsSync(envDir)) {
    console.log(`Creating sandbox directory at: ${envDir}`);
    fs.mkdirSync(envDir, { recursive: true });
  }

  // The "tool path" for terraform is the sandbox dir; temp configs are written
  // there and the terraform binary is on PATH (macOS / Linux / nt same name).
  const sandboxPath = envDir;

  if (terraformVersion) ensureTerraformVersion(sandboxPath, terraformVersion, cfg, verbose);
  return sandboxPath;
}

/** Verify the terraform binary reports `terraformVersion` (soft pin; warns). */
function ensureTerraformVersion(sandboxPath, terraformVersion, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  console.log(`Ensuring terraform==${terraformVersion} in the test environment...`);
  const cmd = ["version", "-json"];
  if (verbose) console.log(`  $ terraform ${cmd.join(" ")}`);
  const res = spawnSync("terraform", cmd, { encoding: "utf8", env: subprocessEnv(cfg) });
  if (verbose) echo(res.stdout, res.stderr);
  let found = "";
  try {
    found = (JSON.parse(res.stdout || "{}").terraform_version) || "";
  } catch {
    found = "";
  }
  if (res.status !== 0 || found !== terraformVersion) {
    console.error(
      `Warning: could not pin terraform==${terraformVersion}: binary reports ${found || "unknown error"}`,
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

/**
 * True if terraform `options` already carry a verbose flag.
 *
 * terraform has no init-level verbosity flag (TF_LOG drives it via the env),
 * so this is always false; kept for parity with the reference's flow.
 */
function hasVerbose(options) {
  return false;
}

/**
 * Run `terraform <cmd>`, echoing combined output live while capturing it.
 *
 * Resolves to `[returncode, combinedOutput]`. Used in verbose mode so the user
 * watches terraform in real time (e.g. a slow provider download or a hang) yet
 * the captured text still feeds the JSON report.
 */
function stream(cmd, env, cwd = null) {
  return new Promise((resolve) => {
    const proc = spawn("terraform", cmd, { env, cwd: cwd || undefined, stdio: ["ignore", "pipe", "pipe"] });
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
 * Write a minimal `main.tf` pinning `package` to `version`.
 *
 * terraform resolves providers from the `required_providers` block during
 * `init`; pinning `version` makes init succeed only if that exact version
 * is downloadable from the registry.
 */
function writeConfig(workDir, pkg, version) {
  const alias = pkg.split("/").pop().replace(/-/g, "_");
  const config =
    "terraform {\n" +
    "  required_providers {\n" +
    `    ${alias} = {\n` +
    `      source  = "${pkg}"\n` +
    `      version = "${version}"\n` +
    "    }\n" +
    "  }\n" +
    "}\n";
  fs.writeFileSync(path.join(workDir, "main.tf"), config);
}

/**
 * Attempt to `terraform init` each version; write an incremental JSON report.
 *
 * Returns the list of result objects. If `firstOnly` is set, stops after
 * the first version that initialises successfully. When `verbose` is set,
 * terraform's full output is streamed live (and TF_LOG=DEBUG is set via the
 * env) so init failures can be debugged; the captured output is also folded
 * into the report under `log`/`error`.
 */
export async function testInstallations(sandboxPath, pkg, indexUrl, versions, outputJson, {
  firstOnly = false, cfg = null, verbose = false,
} = {}) {
  cfg = cfg || resolveEnv();
  const env = subprocessEnv(cfg);
  const options = terraformOptions(cfg);
  const results = [];
  const installable = [];

  for (let idx = 0; idx < versions.length; idx++) {
    const version = versions[idx];
    const target = `${pkg}@${version}`;
    console.log(`[${idx + 1}/${versions.length}] Attempting to init: ${target}...`);

    // Each version gets its own scratch dir + temp main.tf so successive
    // inits do not collide on .terraform plugin state.
    const workDir = fs.mkdtempSync(path.join(sandboxPath, "tf-"));
    writeConfig(workDir, pkg, version);

    const cmd = ["init", "-input=false", "-backend=false", ...options];

    let returncode, stdoutText, stderrText;
    if (verbose) {
      console.log(`  $ terraform ${cmd.join(" ")}  (cwd=${workDir})`);
      const [code, output] = await stream(cmd, env, workDir);
      returncode = code;
      stdoutText = stderrText = output; // streamed combined; same text both ways
    } else {
      const res = spawnSync("terraform", cmd, { encoding: "utf8", env, cwd: workDir });
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
                [--terraform-version TERRAFORM_VERSION] [--output OUTPUT]
                [--limit LIMIT] [--first-only] [-v] package

Find installable versions of a provider from a Terraform registry.

positional arguments:
  package               Provider to probe as <namespace>/<name> (e.g. hashicorp/aws).

options:
  -h, --help            show this help message and exit
  --registry INDEX_URL  Custom provider registry host. Defaults to $TF_REGISTRY,
                        then $PROVIDER_REGISTRY_URL, then registry.terraform.io.
  --venv-dir VENV_DIR   Directory for the isolated init sandbox.
                        (default: .venv-test-install)
  --terraform-version TERRAFORM_VERSION
                        terraform version to expect ('none' to skip the check).
                        (default: ${DEFAULT_TERRAFORM_VERSION})
  --output OUTPUT       Path to write the JSON report.
                        (default: installation_report.json)
  --limit LIMIT         Only test the newest N versions (default: all).
  --first-only          Stop after the first version that initialises successfully.
  -v, --verbose         Stream full terraform output for every step so failures are
                        debuggable.
`;

/** Parse a `main`-style argv list into an options object (mirrors argparse). */
export function parseArgs(argv = null) {
  argv = argv === null ? process.argv.slice(2) : argv;
  const args = {
    package: null,
    indexUrl: null,
    venvDir: ".venv-test-install",
    terraformVersion: DEFAULT_TERRAFORM_VERSION,
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
    } else if (a === "--registry") {
      args.indexUrl = next();
    } else if (a === "--venv-dir") {
      args.venvDir = next();
    } else if (a === "--terraform-version") {
      args.terraformVersion = next();
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

  console.log(`Found ${versions.length} version(s) to test (registry: ${cfg.PROVIDER_REGISTRY_NAME}).`);
  const terraformVersion = String(args.terraformVersion).toLowerCase() === "none" ? null : args.terraformVersion;
  const sandboxPath = setupVenv(args.venvDir, terraformVersion, cfg, args.verbose);
  await testInstallations(sandboxPath, args.package, indexUrl, versions, args.output, {
    firstOnly: args.firstOnly, cfg, verbose: args.verbose,
  });
  return 0;
}

// main() accepts an optional argv list. Pass one explicitly to drive the tool
// programmatically (e.g. from another script or a test); omit it and main()
// falls back to parseArgs(null), which reads from process.argv (normal CLI use).
//
// Example — probe the newest 5 versions of hashicorp/aws, stop at the first installable:
//     main(["hashicorp/aws", "--registry", "registry.terraform.io",
//           "--limit", "5", "--first-only"])
//
// Equivalent on the command line:
//     node main.mjs hashicorp/aws \
//         --registry registry.terraform.io --limit 5 --first-only

import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then((code) => process.exit(code)); // argv=null -> parseArgs reads process.argv
}
