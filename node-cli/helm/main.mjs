#!/usr/bin/env node
/**
 * Find pullable versions of a chart from a (custom) Helm chart repository.
 *
 * Discovers every version a chart repo advertises for a chart via
 * `helm search repo <repo>/<chart> --versions`, then attempts to `helm pull`
 * each one into an isolated destination directory, recording success/failure per
 * version to a JSON report.
 *
 * Example:
 *     node main.mjs bitnami/nginx \
 *         --repo-url https://charts.bitnami.com/bitnami
 *
 *     # only probe the newest 5 versions, stop at the first that pulls
 *     node main.mjs bitnami/nginx --repo-url https://charts.bitnami.com/bitnami \
 *         --limit 5 --first-only
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// helm version the test environment is pinned to by default. Pull-tests run
// against this helm, so it governs repo/OCI behaviour. This is a soft pin (we
// only warn if helm reports a different version) since the helm binary is
// host-provided, not bootstrapped. Override via --helm-version (CLI) or the
// `helm` command (REPL).
export const DEFAULT_HELM_VERSION = "3.16.3";

// Environment knobs read via process.env, each falling back to the value the
// Helm ecosystem uses by default ("industry standard"). helm itself auto-reads
// HELM_* vars from the environment; we resolve them explicitly so the documented
// default still applies when the var is unset, and so they can be surfaced (REPL
// `env`) and threaded into every helm invocation we build.
export const ENV_DEFAULTS = {
  HELM_VERBOSE: "0",                                // our: quiet (0 = no --debug)
  HELM_CACERT: "",                                  // helm: TLS CA cert file
  HELM_REPOSITORY_CONFIG: "",                       // helm: repositories.yaml path
  HELM_REPOSITORY_CACHE: "",                        // helm: repo cache dir
  HELM_REPO_URL: "https://charts.helm.sh/stable",   // chart repo URL for listing
  HELM_DEFAULT_TIMEOUT: "15",                       // our: 15s timeout hint
  HELM_RETRIES: "5",                                // our: 5 connection retries
  CHART_REGISTRY_URL: "https://charts.helm.sh/stable",  // our repo-url fallback
  CHART_REGISTRY_NAME: "Helm Stable",               // registry display name
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

/** Pick the chart repo URL: explicit flag > HELM_REPO_URL > CHART_REGISTRY_URL. */
export function resolveIndexUrl(explicit, cfg = null) {
  cfg = cfg || resolveEnv();
  return explicit || cfg.HELM_REPO_URL || cfg.CHART_REGISTRY_URL || null;
}

/** Translate resolved config into helm command-line flags. */
export function helmOptions(cfg) {
  const opts = [];
  const parsed = parseInt(cfg.HELM_VERBOSE, 10);
  const level = Number.isNaN(parsed) ? 0 : parsed;
  if (level > 0) opts.push("--debug"); // helm: verbose debug output
  if (cfg.HELM_CACERT) opts.push("--ca-file", cfg.HELM_CACERT);
  return opts;
}

/** Child-process environment with resolved TLS cert vars applied. */
export function subprocessEnv(cfg) {
  const env = { ...process.env };
  for (const name of TLS_ENV_VARS) {
    if (cfg[name]) env[name] = cfg[name];
  }
  if (cfg.HELM_REPOSITORY_CONFIG) env.HELM_REPOSITORY_CONFIG = cfg.HELM_REPOSITORY_CONFIG;
  if (cfg.HELM_REPOSITORY_CACHE) env.HELM_REPOSITORY_CACHE = cfg.HELM_REPOSITORY_CACHE;
  return env;
}

/**
 * Split `<repo>/<chart>` into `[repoAlias, chart]`.
 *
 * helm references charts as `<repo-alias>/<chart>`; the alias is a local name
 * registered with `helm repo add`. When no slash is present we treat the whole
 * token as the chart and synthesize a stable alias.
 */
function splitChart(pkg) {
  if (pkg.includes("/")) {
    const idx = pkg.indexOf("/");
    const alias = pkg.slice(0, idx);
    const chart = pkg.slice(idx + 1);
    return [alias, chart];
  }
  return ["probe", pkg];
}

/** Register the chart repo locally so `search`/`pull` can resolve it. */
function repoAdd(alias, repoUrl, cfg, verbose = false) {
  const cmd = ["repo", "add", alias, repoUrl, ...helmOptions(cfg)];
  if (verbose) console.log(`  $ helm ${cmd.join(" ")}`);
  const res = spawnSync("helm", cmd, {
    encoding: "utf8",
    env: subprocessEnv(cfg),
    maxBuffer: 50 * 1024 * 1024, // defensive guard against future verbose output
  });
  if (verbose) echo(res.stdout, res.stderr);
  // Refresh the index so search sees the latest versions.
  const upd = ["repo", "update", alias, ...helmOptions(cfg)];
  if (verbose) console.log(`  $ helm ${upd.join(" ")}`);
  spawnSync("helm", upd, {
    encoding: "utf8",
    env: subprocessEnv(cfg),
    maxBuffer: 50 * 1024 * 1024, // defensive guard against future verbose output
  });
}

/**
 * Return the list of versions a chart repo advertises for `package`.
 *
 * Versions are returned newest-first, mirroring `helm search repo --versions`
 * (which lists newest first). When `verbose` is set, the helm command and its
 * raw output are echoed so a failed or empty discovery can be debugged.
 */
export function getAvailableVersions(pkg, indexUrl, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  console.log(`Retrieving versions for '${pkg}' from ${indexUrl}...`);
  const [alias, chart] = splitChart(pkg);
  if (indexUrl) repoAdd(alias, indexUrl, cfg, verbose);

  // Strip `--debug` from the discovery query: we only need the small JSON
  // version list, but verbose helm floods debug output that can overflow
  // spawnSync's default 1MB buffer, killing the child (status=null) with an
  // empty stderr.
  const cmd = ["search", "repo", `${alias}/${chart}`, "--versions", "--output", "json"];
  cmd.push(...stripVerbose(helmOptions(cfg)));
  if (verbose) console.log(`  $ helm ${cmd.join(" ")}`);

  const res = spawnSync("helm", cmd, {
    encoding: "utf8",
    env: subprocessEnv(cfg),
    maxBuffer: 50 * 1024 * 1024, // defensive guard against future verbose output
  });
  if (res.status !== 0) {
    if (verbose) echo(res.stdout, res.stderr);
    // status is null when the child was killed by a signal (e.g. spawnSync
    // SIGTERM on buffer overflow) — stderr is empty in that case, so fall back
    // to the signal name / spawn error so the failure isn't reported blank.
    const detail = (res.stderr || "").trim()
      || (res.signal && `terminated by signal ${res.signal}`)
      || (res.error && res.error.message)
      || "unknown error";
    console.error(`Error running 'helm search repo': ${detail}`);
    process.exit(1);
  }

  if (verbose) echo(res.stdout);
  let entries;
  try {
    entries = JSON.parse(res.stdout || "[]");
  } catch {
    console.error("Could not parse JSON from helm output.");
    return [];
  }
  return entries.filter((e) => e.version).map((e) => e.version);
}

/**
 * Create a fresh pull-destination directory if needed; return its path.
 *
 * For helm the "sandbox" is a scratch destination directory that each
 * `helm pull --destination` writes chart archives into. The helm binary is
 * pinned to `helmVersion` (default `DEFAULT_HELM_VERSION`) as a *soft* check —
 * we warn on mismatch rather than bootstrap a binary. Pass `helmVersion=null`
 * to skip the check. `verbose` echoes the version output so a failed check can
 * be debugged.
 */
export function setupVenv(envDir, helmVersion = DEFAULT_HELM_VERSION, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  if (!fs.existsSync(envDir)) {
    console.log(`Creating chart destination at: ${envDir}`);
    fs.mkdirSync(envDir, { recursive: true });
  }

  // The "tool path" for helm is the destination dir; pulls land there and the
  // helm binary is on PATH (macOS / Linux / nt all use the same name).
  const destPath = envDir;

  if (helmVersion) ensureHelmVersion(destPath, helmVersion, cfg, verbose);
  return destPath;
}

/** Verify the helm binary reports `helmVersion` (soft pin; warns). */
function ensureHelmVersion(destPath, helmVersion, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  console.log(`Ensuring helm==${helmVersion} in the test environment...`);
  const cmd = ["version", "--template", "{{.Version}}", ...helmOptions(cfg)];
  if (verbose) console.log(`  $ helm ${cmd.join(" ")}`);
  const res = spawnSync("helm", cmd, {
    encoding: "utf8",
    env: subprocessEnv(cfg),
    maxBuffer: 50 * 1024 * 1024, // defensive guard against future verbose output
  });
  if (verbose) echo(res.stdout, res.stderr);
  const found = lastLine(res.stdout).replace(/^v/, "");
  if (res.status !== 0 || found !== helmVersion) {
    console.error(
      `Warning: could not pin helm==${helmVersion}: binary reports ${found || "unknown error"}`,
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

/** True if helm `options` already carry a `--debug` flag. */
function hasVerbose(options) {
  return options.some((o) => o === "--debug");
}

/** helm `options` with the `--debug` verbosity flag removed. */
function stripVerbose(options) {
  return options.filter((o) => o !== "--debug");
}

/**
 * Run `helm <cmd>`, echoing combined output live while capturing it.
 *
 * Resolves to `[returncode, combinedOutput]`. Used in verbose mode so the user
 * watches helm in real time (e.g. a slow download or a hang) yet the captured
 * text still feeds the JSON report.
 */
function stream(cmd, env) {
  return new Promise((resolve) => {
    const proc = spawn("helm", cmd, { env, stdio: ["ignore", "pipe", "pipe"] });
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
 * Attempt to `helm pull` each version; write an incremental JSON report.
 *
 * Returns the list of result objects. If `firstOnly` is set, stops after the
 * first version that pulls successfully. When `verbose` is set, helm's full
 * output is streamed live (and a `--debug` flag is added if none is present) so
 * pull failures can be debugged; the captured output is also folded into the
 * report under `log`/`error`.
 */
export async function testInstallations(destPath, pkg, indexUrl, versions, outputJson, {
  firstOnly = false, cfg = null, verbose = false,
} = {}) {
  cfg = cfg || resolveEnv();
  const env = subprocessEnv(cfg);
  const options = helmOptions(cfg);
  const [alias, chart] = splitChart(pkg);
  const results = [];
  const installable = [];

  for (let idx = 0; idx < versions.length; idx++) {
    const version = versions[idx];
    const target = `${alias}/${chart}:${version}`;
    console.log(`[${idx + 1}/${versions.length}] Attempting to pull: ${target}...`);

    // Each version downloads into its own scratch dir under the destination
    // so successive pulls do not collide on archive filenames.
    const scratch = fs.mkdtempSync(path.join(destPath, "helm-"));
    const cmd = [
      "pull",
      `${alias}/${chart}`,
      "--version",
      version,
      "--destination",
      scratch,
    ];
    cmd.push(...options);
    // Bump helm's own verbosity if the user wants detail and nothing set it.
    if (verbose && !hasVerbose(options)) cmd.push("--debug");

    let returncode, stdoutText, stderrText;
    if (verbose) {
      console.log(`  $ helm ${cmd.join(" ")}`);
      const [code, output] = await stream(cmd, env);
      returncode = code;
      stdoutText = stderrText = output; // streamed combined; same text both ways
    } else {
      const res = spawnSync("helm", cmd, {
        encoding: "utf8",
        env,
        maxBuffer: 50 * 1024 * 1024, // defensive guard against future verbose output
      });
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
      console.log(`  First pullable version found: ${installable[0]} (stopping).`);
      break;
    }
  }

  console.log(`\nTesting complete! Results saved to ${outputJson}`);
  if (installable.length) {
    console.log(`Pullable versions (${installable.length}): ${installable.join(", ")}`);
  } else {
    console.log("No pullable versions found.");
  }
  return results;
}

const HELP = `usage: main.mjs [-h] [--repo-url INDEX_URL] [--venv-dir VENV_DIR]
                [--helm-version HELM_VERSION] [--output OUTPUT] [--limit LIMIT]
                [--first-only] [-v] package

Find pullable versions of a chart from a Helm repository.

positional arguments:
  package               Chart to probe as <repo>/<chart> (e.g. bitnami/nginx).

options:
  -h, --help            show this help message and exit
  --repo-url INDEX_URL  Custom chart repository URL. Defaults to $HELM_REPO_URL,
                        then $CHART_REGISTRY_URL, then https://charts.helm.sh/stable.
  --venv-dir VENV_DIR   Directory for the isolated chart-pull destination.
                        (default: .venv-test-install)
  --helm-version HELM_VERSION
                        helm version to expect ('none' to skip the check).
                        (default: ${DEFAULT_HELM_VERSION})
  --output OUTPUT       Path to write the JSON report.
                        (default: installation_report.json)
  --limit LIMIT         Only test the newest N versions (default: all).
  --first-only          Stop after the first version that pulls successfully.
  -v, --verbose         Stream full helm output for every step so failures are
                        debuggable.
`;

/** Parse a `main`-style argv list into an options object (mirrors argparse). */
export function parseArgs(argv = null) {
  argv = argv === null ? process.argv.slice(2) : argv;
  const args = {
    package: null,
    indexUrl: null,
    venvDir: ".venv-test-install",
    helmVersion: DEFAULT_HELM_VERSION,
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
    } else if (a === "--repo-url") {
      args.indexUrl = next();
    } else if (a === "--venv-dir") {
      args.venvDir = next();
    } else if (a === "--helm-version") {
      args.helmVersion = next();
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

  console.log(`Found ${versions.length} version(s) to test (registry: ${cfg.CHART_REGISTRY_NAME}).`);
  const helmVersion = String(args.helmVersion).toLowerCase() === "none" ? null : args.helmVersion;
  const destPath = setupVenv(args.venvDir, helmVersion, cfg, args.verbose);
  await testInstallations(destPath, args.package, indexUrl, versions, args.output, {
    firstOnly: args.firstOnly, cfg, verbose: args.verbose,
  });
  return 0;
}

// main() accepts an optional argv list. Pass one explicitly to drive the tool
// programmatically (e.g. from another script or a test); omit it and main()
// falls back to parseArgs(null), which reads from process.argv (normal CLI use).
//
// Example — probe the newest 5 versions of bitnami/nginx, stop at the first pullable:
//     main(["bitnami/nginx", "--repo-url", "https://charts.bitnami.com/bitnami",
//           "--limit", "5", "--first-only"])
//
// Equivalent on the command line:
//     node main.mjs bitnami/nginx \
//         --repo-url https://charts.bitnami.com/bitnami --limit 5 --first-only

import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then((code) => process.exit(code)); // argv=null -> parseArgs reads process.argv
}
