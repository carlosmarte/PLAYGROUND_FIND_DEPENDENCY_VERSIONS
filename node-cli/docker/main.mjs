#!/usr/bin/env node
/**
 * Find pullable tags of an image from a (custom) container registry.
 *
 * Discovers every tag a registry advertises for a repository via the registry v2
 * `/v2/<repo>/tags/list` API (or the Docker Hub `/v2/repositories` API), then
 * attempts to `docker pull` each one into the local daemon, recording
 * success/failure per tag to a JSON report.
 *
 * Example:
 *     node main.mjs library/nginx \
 *         --registry registry-1.docker.io
 *
 *     # only probe the newest 5 tags, stop at the first that pulls
 *     node main.mjs library/nginx --registry registry-1.docker.io \
 *         --limit 5 --first-only
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// docker CLI version the test environment is pinned to by default. Pull-tests
// run against this docker, so it governs daemon/registry behaviour. This is a
// soft pin (we only warn if the daemon reports a different version) since the
// docker client is host-provided, not bootstrapped. Override via --docker-version
// (CLI) or the `docker` command (REPL).
export const DEFAULT_DOCKER_VERSION = "27.3.1";

// Environment knobs read via process.env, each falling back to the value the
// container ecosystem uses by default ("industry standard"). docker itself
// auto-reads DOCKER_* vars from the environment; we resolve them explicitly so
// the documented default still applies when the var is unset, and so they can be
// surfaced (REPL `env`) and threaded into every docker invocation we build.
export const ENV_DEFAULTS = {
  DOCKER_VERBOSE: "0",                              // our: quiet (0 = no debug)
  DOCKER_CERT_PATH: "",                             // docker: TLS client certs dir
  DOCKER_TLS_VERIFY: "",                            // docker: verify daemon TLS
  DOCKER_HOST: "",                                  // docker: daemon socket/host
  DOCKER_REGISTRY: "registry-1.docker.io",          // registry v2 host for listing
  DOCKER_DEFAULT_TIMEOUT: "15",                     // our: 15s HTTP timeout
  DOCKER_RETRIES: "5",                             // our: 5 connection retries
  CONTAINER_REGISTRY_URL: "registry-1.docker.io",   // our registry-host fallback
  CONTAINER_REGISTRY_NAME: "Docker Hub",            // registry display name
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

/** Pick the registry host: explicit flag > DOCKER_REGISTRY > CONTAINER_REGISTRY_URL. */
export function resolveIndexUrl(explicit, cfg = null) {
  cfg = cfg || resolveEnv();
  return explicit || cfg.DOCKER_REGISTRY || cfg.CONTAINER_REGISTRY_URL || null;
}

/** Translate resolved config into docker command-line flags. */
export function dockerOptions(cfg) {
  const opts = [];
  let level;
  try {
    level = parseInt(cfg.DOCKER_VERBOSE, 10);
    if (Number.isNaN(level)) level = 0;
  } catch {
    level = 0;
  }
  if (level > 0) opts.push("--debug"); // docker: client debug output
  if (cfg.DOCKER_HOST) opts.push("--host", cfg.DOCKER_HOST);
  if (cfg.DOCKER_TLS_VERIFY) opts.push("--tlsverify");
  if (cfg.DOCKER_CERT_PATH) opts.push("--tlscacert", path.join(cfg.DOCKER_CERT_PATH, "ca.pem"));
  return opts;
}

/** Child-process environment with resolved TLS cert vars applied. */
export function subprocessEnv(cfg) {
  const env = { ...process.env };
  for (const name of TLS_ENV_VARS) {
    if (cfg[name]) env[name] = cfg[name];
  }
  if (cfg.DOCKER_CERT_PATH) env.DOCKER_CERT_PATH = cfg.DOCKER_CERT_PATH;
  return env;
}

/**
 * GET `url` and parse a JSON body via global `fetch` (no third-party deps).
 *
 * Resolves to the decoded JSON object, or `null` on any HTTP/parse error (the
 * caller degrades gracefully). `verbose` echoes the request and any error.
 */
async function httpGetJson(url, cfg, headers = null, verbose = false) {
  let timeout;
  try {
    timeout = parseInt(cfg.DOCKER_DEFAULT_TIMEOUT, 10);
    if (Number.isNaN(timeout)) timeout = 15;
  } catch {
    timeout = 15;
  }
  if (verbose) console.log(`  $ GET ${url}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout * 1000);
  try {
    const resp = await fetch(url, { headers: headers || {}, signal: controller.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
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
 * Fetch an anonymous Docker Hub pull token for `repo` (scope-limited).
 *
 * The registry v2 `tags/list` endpoint on Docker Hub requires a bearer token
 * even for public images; we mint a read-only one from auth.docker.io. Returns
 * the token string, or `null` when no auth is needed/available.
 */
async function pullToken(repo, cfg, verbose = false) {
  const url =
    "https://auth.docker.io/token" +
    `?service=registry.docker.io&scope=repository:${repo}:pull`;
  const data = await httpGetJson(url, cfg, null, verbose);
  return (data || {}).token || null;
}

/**
 * Return the list of tags a registry advertises for `package`.
 *
 * Tags are returned newest-first. We prefer the Docker Hub `/v2/repositories`
 * API (which sorts by last-pushed) and fall back to the registry v2
 * `/v2/<repo>/tags/list` (with an anonymous pull token). When `verbose` is set,
 * the requests and raw responses are echoed so a failed or empty discovery can
 * be debugged.
 */
export async function getAvailableVersions(pkg, indexUrl, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  console.log(`Retrieving tags for '${pkg}' from ${indexUrl}...`);

  // Preferred path: Docker Hub's repositories API returns newest-first tags.
  const hubUrl =
    `https://hub.docker.com/v2/repositories/${pkg}/tags` +
    "?page_size=100&ordering=last_updated";
  let data = await httpGetJson(hubUrl, cfg, null, verbose);
  if (data && Array.isArray(data.results)) {
    const tags = data.results.map((r) => r.name).filter((n) => n);
    if (tags.length) return tags;
  }

  // Fallback: registry v2 tags/list (alphabetical) — reverse to approximate
  // newest-first, after minting an anonymous pull token for Docker Hub.
  const token = await pullToken(pkg, cfg, verbose);
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const v2Url = `https://${indexUrl}/v2/${pkg}/tags/list`;
  data = await httpGetJson(v2Url, cfg, headers, verbose);
  if (!data || !Array.isArray(data.tags)) {
    console.error("Could not find 'tags' in registry response.");
    return [];
  }
  return data.tags.filter((t) => t).reverse();
}

/**
 * Prepare an isolated pull sandbox if needed; return its scratch dir.
 *
 * For docker the "sandbox" is just a scratch directory used to mark the session
 * (the pulled images land in the shared local daemon, which has no per-call
 * isolation). The docker client is pinned to `dockerVersion` (default
 * `DEFAULT_DOCKER_VERSION`) as a *soft* check — we warn on mismatch rather than
 * bootstrap a client. Pass `dockerVersion=null` to skip the check. `verbose`
 * echoes the version output so a failed check can be debugged.
 */
export function setupVenv(envDir, dockerVersion = DEFAULT_DOCKER_VERSION, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  if (!fs.existsSync(envDir)) {
    console.log(`Creating sandbox directory at: ${envDir}`);
    fs.mkdirSync(envDir, { recursive: true });
  }

  // The "tool path" for docker is just the docker executable name; the daemon
  // is shared, so there is no per-env binary to locate (macOS / Linux / nt).
  const dockerPath = "docker";

  if (dockerVersion) ensureDockerVersion(dockerPath, dockerVersion, cfg, verbose);
  return dockerPath;
}

/** Verify the docker client reports `dockerVersion` (soft pin; warns). */
function ensureDockerVersion(dockerPath, dockerVersion, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  console.log(`Ensuring docker==${dockerVersion} in the test environment...`);
  const cmd = [...dockerOptions(cfg), "version", "--format", "{{.Client.Version}}"];
  if (verbose) console.log(`  $ ${dockerPath} ${cmd.join(" ")}`);
  const res = spawnSync(dockerPath, cmd, { encoding: "utf8", env: subprocessEnv(cfg) });
  if (verbose) echo(res.stdout, res.stderr);
  const found = lastLine(res.stdout);
  if (res.status !== 0 || found !== dockerVersion) {
    console.error(
      `Warning: could not pin docker==${dockerVersion}: ` +
      `client reports ${found || "unknown error"}`,
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

/** True if docker `options` already carry a `--debug` flag. */
function hasVerbose(options) {
  return options.some((o) => o === "--debug");
}

/**
 * Run `docker cmd`, echoing combined output live while capturing it.
 *
 * Resolves to `[returncode, combinedOutput]`. Used in verbose mode so the user
 * watches docker in real time (e.g. a slow layer pull or a hang) yet the
 * captured text still feeds the JSON report.
 */
function stream(dockerPath, cmd, env) {
  return new Promise((resolve) => {
    const proc = spawn(dockerPath, cmd, { env, stdio: ["ignore", "pipe", "pipe"] });
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
 * Attempt to `docker pull` each tag; write an incremental JSON report.
 *
 * Returns the list of result objects. If `firstOnly` is set, stops after the
 * first tag that pulls successfully. When `verbose` is set, docker's full output
 * is streamed live (and a `--debug` flag is added if none is present) so pull
 * failures can be debugged; the captured output is also folded into the report
 * under `log`/`error`.
 */
export async function testInstallations(dockerPath, pkg, indexUrl, versions, outputJson, {
  firstOnly = false, cfg = null, verbose = false,
} = {}) {
  cfg = cfg || resolveEnv();
  const env = subprocessEnv(cfg);
  const options = dockerOptions(cfg);
  const results = [];
  const installable = [];

  for (let idx = 0; idx < versions.length; idx++) {
    const version = versions[idx];
    // docker pull targets a fully-qualified <registry>/<repo>:<tag> ref.
    const ref = indexUrl ? `${indexUrl}/${pkg}:${version}` : `${pkg}:${version}`;
    const target = `${pkg}:${version}`;
    console.log(`[${idx + 1}/${versions.length}] Attempting to pull: ${target}...`);

    let cmd = [];
    // Bump docker's own verbosity if the user wants detail and nothing set it.
    if (verbose && !hasVerbose(options)) cmd.push("--debug");
    cmd = cmd.concat(options);
    cmd.push("pull", ref);

    let returncode, stdoutText, stderrText;
    if (verbose) {
      console.log(`  $ ${dockerPath} ${cmd.join(" ")}`);
      const [code, output] = await stream(dockerPath, cmd, env);
      returncode = code;
      stdoutText = stderrText = output; // streamed combined; same text both ways
    } else {
      const res = spawnSync(dockerPath, cmd, { encoding: "utf8", env });
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
      console.log(`  First pullable tag found: ${installable[0]} (stopping).`);
      break;
    }
  }

  console.log(`\nTesting complete! Results saved to ${outputJson}`);
  if (installable.length) {
    console.log(`Pullable tags (${installable.length}): ${installable.join(", ")}`);
  } else {
    console.log("No pullable tags found.");
  }
  return results;
}

const HELP = `usage: main.mjs [-h] [--registry INDEX_URL] [--venv-dir VENV_DIR]
                [--docker-version DOCKER_VERSION] [--output OUTPUT]
                [--limit LIMIT] [--first-only] [-v] package

Find pullable tags of an image from a container registry.

positional arguments:
  package               Repository to probe (e.g. library/nginx).

options:
  -h, --help            show this help message and exit
  --registry INDEX_URL  Custom registry host. Defaults to $DOCKER_REGISTRY,
                        then $CONTAINER_REGISTRY_URL, then registry-1.docker.io.
  --venv-dir VENV_DIR   Directory for the isolated pull sandbox.
                        (default: .venv-test-install)
  --docker-version DOCKER_VERSION
                        docker client version to expect ('none' to skip the
                        check). (default: ${DEFAULT_DOCKER_VERSION})
  --output OUTPUT       Path to write the JSON report.
                        (default: installation_report.json)
  --limit LIMIT         Only test the newest N tags (default: all).
  --first-only          Stop after the first tag that pulls successfully.
  -v, --verbose         Stream full docker output for every step so failures are
                        debuggable.
`;

/** Parse a `main`-style argv list into an options object (mirrors argparse). */
export function parseArgs(argv = null) {
  argv = argv === null ? process.argv.slice(2) : argv;
  const args = {
    package: null,
    indexUrl: null,
    venvDir: ".venv-test-install",
    dockerVersion: DEFAULT_DOCKER_VERSION,
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
    } else if (a === "--docker-version") {
      args.dockerVersion = next();
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
    console.log("No tags found. Exiting.");
    return 1;
  }

  if (args.limit !== null && !Number.isNaN(args.limit)) {
    versions = versions.slice(0, args.limit);
  }

  console.log(`Found ${versions.length} tag(s) to test (registry: ${cfg.CONTAINER_REGISTRY_NAME}).`);
  const dockerVersion = String(args.dockerVersion).toLowerCase() === "none" ? null : args.dockerVersion;
  const dockerPath = setupVenv(args.venvDir, dockerVersion, cfg, args.verbose);
  await testInstallations(dockerPath, args.package, indexUrl, versions, args.output, {
    firstOnly: args.firstOnly, cfg, verbose: args.verbose,
  });
  return 0;
}

// main() accepts an optional argv list. Pass one explicitly to drive the tool
// programmatically (e.g. from another script or a test); omit it and main()
// falls back to parseArgs(null), which reads from process.argv (normal CLI use).
//
// Example — probe the newest 5 tags of library/nginx, stop at the first pullable:
//     main(["library/nginx", "--registry", "registry-1.docker.io",
//           "--limit", "5", "--first-only"])
//
// Equivalent on the command line:
//     node main.mjs library/nginx \
//         --registry registry-1.docker.io --limit 5 --first-only

import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then((code) => process.exit(code)); // argv=null -> parseArgs reads process.argv
}
