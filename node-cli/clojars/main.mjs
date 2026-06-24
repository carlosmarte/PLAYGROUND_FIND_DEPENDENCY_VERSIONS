#!/usr/bin/env node
/**
 * Find resolvable versions of an artifact from Clojars (or a Maven repo).
 *
 * Discovers every version Clojars advertises for a `groupId:artifactId`
 * coordinate via the Clojars JSON API (falling back to `maven-metadata.xml` on
 * `repo.clojars.org`), then attempts to resolve each one into an isolated local
 * Maven repository via `mvn dependency:get`, recording success/failure per
 * version to a JSON report.
 *
 * Example:
 *     node main.mjs org.clojure:clojure \
 *         --repo-url https://repo.clojars.org
 *
 *     # only probe the newest 5 versions, stop at the first that resolves
 *     node main.mjs org.clojure:clojure --repo-url https://repo.clojars.org \
 *         --limit 5 --first-only
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// clojure/lein version the test environment is pinned to by default. Resolve-tests
// run against this toolchain, so it governs resolver/repository behaviour. Override
// via --clojure-version (CLI) or the `clojure` command (REPL).
export const DEFAULT_CLOJURE_VERSION = "1.12.0";

// Environment knobs read via process.env, each falling back to the value the
// Clojure / JVM ecosystem uses by default ("industry standard"). The Maven-style
// resolver reads settings from the environment; we resolve them explicitly so the
// documented default still applies when the var is unset, and so they can be
// surfaced (REPL `env`) and threaded into every invocation we build.
export const ENV_DEFAULTS = {
  CLOJARS_VERBOSE: "0",                            // mvn: quiet (0 = no -X)
  CLOJARS_TRANSFER_TIMEOUT: "15",                  // mvn: 15s transfer timeout
  CLOJARS_REPO_URL: "https://repo.clojars.org",    // mvn: remote repo base
  MAVEN_OPTS: "",                                  // mvn: extra JVM opts
  JVM_REGISTRY_URL: "https://repo.clojars.org",    // our repo-url fallback
  JVM_REGISTRY_NAME: "Clojars",                    // registry display name
  CLOJARS_API_URL: "https://clojars.org/api",      // clojars JSON API base
  HTTPS_PROXY: "",                                 // http: optional proxy
  HTTP_PROXY: "",                                  // http: optional proxy
  NO_PROXY: "",                                    // http: proxy bypass list
};

// HTTP/proxy vars passed through to child processes via the environment (no CLI flag).
const TLS_ENV_VARS = ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"];

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

/** Pick the repo URL: explicit flag > CLOJARS_REPO_URL > JVM_REGISTRY_URL. */
export function resolveIndexUrl(explicit, cfg = null) {
  cfg = cfg || resolveEnv();
  return explicit || cfg.CLOJARS_REPO_URL || cfg.JVM_REGISTRY_URL || null;
}

/** Translate resolved config into mvn command-line flags. */
export function clojarsOptions(cfg) {
  const opts = [];
  let level;
  try {
    level = parseInt(cfg.CLOJARS_VERBOSE, 10);
    if (Number.isNaN(level)) level = 0;
  } catch {
    level = 0;
  }
  if (level > 0) opts.push("-X"); // maven debug output
  // Bound the remote transfer so a hung mirror fails fast rather than blocking.
  opts.push("-Dmaven.wagon.httpconnectionManager.ttlSeconds=" + String(cfg.CLOJARS_TRANSFER_TIMEOUT));
  return opts;
}

/** Child-process environment with resolved HTTP/proxy vars applied. */
export function subprocessEnv(cfg) {
  const env = { ...process.env };
  for (const name of TLS_ENV_VARS) {
    if (cfg[name]) env[name] = cfg[name];
  }
  if (cfg.MAVEN_OPTS) env.MAVEN_OPTS = cfg.MAVEN_OPTS;
  return env;
}

/**
 * Split `groupId:artifactId` (or `group/artifact`) into `[group, artifact]`.
 *
 * Clojars commonly writes coordinates as `group/artifact` (Leiningen style);
 * we accept either separator and normalise to a `[group, artifact]` pair.
 */
function splitCoordinate(pkg) {
  const sep = pkg.includes(":") ? ":" : (pkg.includes("/") ? "/" : null);
  if (sep === null) {
    console.error(
      `Coordinate must be 'groupId:artifactId' or 'group/artifact' (got '${pkg}').`,
    );
    process.exit(1);
  }
  const idx = pkg.indexOf(sep);
  const group = pkg.slice(0, idx);
  const artifact = pkg.slice(idx + 1);
  return [group.trim(), artifact.trim()];
}

/** Fetch versions from the Clojars JSON API, newest-first; [] on any miss. */
async function versionsFromApi(group, artifact, cfg, verbose = false) {
  const api = cfg.CLOJARS_API_URL.replace(/\/+$/, "");
  const url = `${api}/artifacts/${group}/${artifact}`;
  if (verbose) console.log(`  $ GET ${url}`);
  let data;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      parseInt(cfg.CLOJARS_TRANSFER_TIMEOUT, 10) * 1000,
    );
    try {
      const resp = await fetch(url, { signal: controller.signal });
      data = JSON.parse(await resp.text());
    } finally {
      clearTimeout(timeout);
    }
  } catch (e) { // API miss falls back to maven-metadata.xml
    if (verbose) console.log(`  (clojars API miss: ${e})`);
    return [];
  }
  // Prefer the explicit recent_versions list, else the flat versions list.
  const recent = data.recent_versions || [];
  let versions = recent.map((v) => v.version).filter((v) => v);
  if (!versions.length) {
    versions = (data.versions || []).filter((v) => v);
  }
  return versions;
}

/** Fetch versions from `maven-metadata.xml` on the repo, newest-first. */
async function versionsFromMetadata(group, artifact, base, cfg, verbose = false) {
  const groupPath = group.replace(/\./g, "/");
  const url = `${base.replace(/\/+$/, "")}/${groupPath}/${artifact}/maven-metadata.xml`;
  if (verbose) console.log(`  $ GET ${url}`);
  let body;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      parseInt(cfg.CLOJARS_TRANSFER_TIMEOUT, 10) * 1000,
    );
    try {
      const resp = await fetch(url, { signal: controller.signal });
      body = await resp.text();
    } finally {
      clearTimeout(timeout);
    }
  } catch (e) { // any fetch failure is a hard discovery error
    console.error(`Error fetching maven-metadata.xml: ${e}`);
    process.exit(1);
  }
  if (verbose) echo(body);
  // Node has no stdlib XML parser; collect each `<version>...</version>` text
  // with a RegExp (maven-metadata.xml uses unprefixed <version> elements).
  const versions = [];
  const re = /<version>([^<]*)<\/version>/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const text = m[1].trim();
    if (text) versions.push(text);
  }
  // maven-metadata.xml lists oldest-first; reverse so newest leads (mirrors pip).
  return versions.reverse();
}

/**
 * Return the list of versions Clojars advertises for `pkg`.
 *
 * Versions are returned newest-first. Discovery prefers the Clojars JSON API
 * (`/api/artifacts/<group>/<artifact>`) and falls back to the artifact's
 * `maven-metadata.xml` on `repo.clojars.org` when the API has nothing. When
 * `verbose` is set, the URLs hit and their raw bodies are echoed so a failed or
 * empty discovery can be debugged.
 */
export async function getAvailableVersions(pkg, indexUrl, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  const [group, artifact] = splitCoordinate(pkg);
  const base = indexUrl || cfg.CLOJARS_REPO_URL;
  console.log(`Retrieving versions for '${pkg}' from ${cfg.JVM_REGISTRY_NAME}...`);

  let versions = await versionsFromApi(group, artifact, cfg, verbose);
  if (!versions.length) {
    versions = await versionsFromMetadata(group, artifact, base, cfg, verbose);
  }
  if (!versions.length) {
    console.error("Could not find any versions via the Clojars API or maven-metadata.xml.");
    return [];
  }
  return versions;
}

/**
 * Create a fresh isolated local Maven repository if needed; return its path.
 *
 * The sandbox is a throwaway directory used as `-Dmaven.repo.local` so every
 * resolve-test fetches fresh into a known location, isolated from the host's
 * `~/.m2`. `clojureVersion` is recorded for parity with the reference (the test
 * step runs against whatever `mvn`/`clojure` is on PATH); pass
 * `clojureVersion=null` to skip the version check. `verbose` echoes the version
 * output so a failed check can be debugged.
 */
export function setupVenv(envDir, clojureVersion = DEFAULT_CLOJURE_VERSION, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  if (!fs.existsSync(envDir)) {
    console.log(`Creating local Maven repository at: ${envDir}`);
    fs.mkdirSync(envDir, { recursive: true });
  }

  if (clojureVersion) ensureClojureVersion(clojureVersion, cfg, verbose);
  // The "handle" the test step needs is just the local-repo path.
  return envDir;
}

/** Check the `clojure` (or `mvn`) on PATH and warn if it can't be probed. */
function ensureClojureVersion(clojureVersion, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  console.log(`Ensuring clojure==${clojureVersion} in the test environment...`);
  const cmd = ["--version"];
  if (verbose) console.log(`  $ clojure ${cmd.join(" ")}`);
  const res = spawnSync("clojure", cmd, {
    encoding: "utf8",
    env: subprocessEnv(cfg),
    maxBuffer: 50 * 1024 * 1024, // defensive guard against future verbose output
  });
  if (res.error && res.error.code === "ENOENT") {
    console.error(
      `Warning: could not pin clojure==${clojureVersion}: clojure not found on PATH`,
    );
    return;
  }
  if (verbose) echo(res.stdout, res.stderr);
  if (res.status !== 0) {
    // status is null when the child was killed by a signal — stderr/stdout are
    // empty in that case, so fall back to the signal name / spawn error.
    const detail = lastLine(res.stderr) || lastLine(res.stdout)
      || (res.signal && `terminated by signal ${res.signal}`)
      || (res.error && res.error.message)
      || "unknown error";
    console.error(`Warning: could not pin clojure==${clojureVersion}: ${detail}`);
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

/** True if mvn `options` already carry a `-X` debug flag. */
function hasVerbose(options) {
  return options.some((o) => o === "-X");
}

/**
 * Run `cmd`, echoing combined output live while capturing it.
 *
 * Resolves to `[returncode, combinedOutput]`. Used in verbose mode so the user
 * watches mvn in real time (e.g. a slow build or a hang) yet the captured text
 * still feeds the JSON report.
 */
function stream(cmd, env) {
  return new Promise((resolve) => {
    const proc = spawn("mvn", cmd, { env, stdio: ["ignore", "pipe", "pipe"] });
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
 * Attempt to resolve each version; write an incremental JSON report.
 *
 * Each version is resolved via Maven-style `mvn dependency:get` pointed at the
 * Clojars repository. Returns the list of result objects. If `firstOnly` is set,
 * stops after the first version that resolves successfully. When `verbose` is
 * set, mvn's full output is streamed live (and a `-X` flag is added if none is
 * present) so resolution failures can be debugged; the captured output is also
 * folded into the report under `log`/`error`.
 */
export async function testInstallations(repoLocal, pkg, indexUrl, versions, outputJson, {
  firstOnly = false, cfg = null, verbose = false,
} = {}) {
  cfg = cfg || resolveEnv();
  const env = subprocessEnv(cfg);
  const options = clojarsOptions(cfg);
  const [group, artifact] = splitCoordinate(pkg);
  const repo = indexUrl || cfg.CLOJARS_REPO_URL;
  const results = [];
  const installable = [];

  for (let idx = 0; idx < versions.length; idx++) {
    const version = versions[idx];
    const target = `${group}:${artifact}:${version}`;
    console.log(`[${idx + 1}/${versions.length}] Attempting to resolve: ${target}...`);

    const cmd = [
      "dependency:get",
      `-Dartifact=${target}`,
      `-DremoteRepositories=clojars::::${repo}`,
      `-Dmaven.repo.local=${repoLocal}`,
      ...options,
    ];
    // Bump mvn's own verbosity if the user wants detail and nothing already set it.
    if (verbose && !hasVerbose(options)) cmd.push("-X");

    let returncode, stdoutText, stderrText;
    if (verbose) {
      console.log(`  $ mvn ${cmd.join(" ")}`);
      const [code, output] = await stream(cmd, env);
      returncode = code;
      stdoutText = stderrText = output; // streamed combined; same text both ways
    } else {
      const res = spawnSync("mvn", cmd, {
        encoding: "utf8",
        env,
        maxBuffer: 50 * 1024 * 1024, // defensive guard against future verbose output
      });
      if (res.error && res.error.code === "ENOENT") {
        returncode = 1;
        stdoutText = "";
        stderrText = res.error.message;
      } else {
        returncode = res.status;
        stdoutText = res.stdout;
        // status is null when the child was killed by a signal — stderr is empty
        // in that case, so fall back to the signal name so the error isn't blank.
        stderrText = res.stderr
          || (res.status === null && res.signal && `terminated by signal ${res.signal}`)
          || res.stderr;
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
      console.log(`  First resolvable version found: ${installable[0]} (stopping).`);
      break;
    }
  }

  console.log(`\nTesting complete! Results saved to ${outputJson}`);
  if (installable.length) {
    console.log(`Resolvable versions (${installable.length}): ${installable.join(", ")}`);
  } else {
    console.log("No resolvable versions found.");
  }
  return results;
}

const HELP = `usage: main.mjs [-h] [--repo-url REPO_URL] [--venv-dir VENV_DIR]
                [--clojure-version CLOJURE_VERSION] [--output OUTPUT]
                [--limit LIMIT] [--first-only] [-v] package

Find resolvable versions of an artifact from Clojars.

positional arguments:
  package               Coordinate to probe as groupId:artifactId or
                        group/artifact (e.g. org.clojure:clojure).

options:
  -h, --help            show this help message and exit
  --repo-url REPO_URL   Custom Maven repository base URL. Defaults to
                        $CLOJARS_REPO_URL, then $JVM_REGISTRY_URL, then
                        https://repo.clojars.org.
  --venv-dir VENV_DIR   Directory for the isolated local Maven repository.
                        (default: .m2-test-repo)
  --clojure-version CLOJURE_VERSION
                        clojure/lein version to verify in the test environment
                        ('none' to skip the check). (default: ${DEFAULT_CLOJURE_VERSION})
  --output OUTPUT       Path to write the JSON report.
                        (default: installation_report.json)
  --limit LIMIT         Only test the newest N versions (default: all).
  --first-only          Stop after the first version that resolves successfully.
  -v, --verbose         Stream full mvn output for every step so failures are
                        debuggable.
`;

/** Parse a `main`-style argv list into an options object (mirrors argparse). */
export function parseArgs(argv = null) {
  argv = argv === null ? process.argv.slice(2) : argv;
  const args = {
    package: null,
    repoUrl: null,
    venvDir: ".m2-test-repo",
    clojureVersion: DEFAULT_CLOJURE_VERSION,
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
      args.repoUrl = next();
    } else if (a === "--venv-dir") {
      args.venvDir = next();
    } else if (a === "--clojure-version") {
      args.clojureVersion = next();
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
  const indexUrl = resolveIndexUrl(args.repoUrl, cfg);

  let versions = await getAvailableVersions(args.package, indexUrl, cfg, args.verbose);
  if (!versions.length) {
    console.log("No versions found. Exiting.");
    return 1;
  }

  if (args.limit !== null && !Number.isNaN(args.limit)) {
    versions = versions.slice(0, args.limit);
  }

  console.log(`Found ${versions.length} version(s) to test (registry: ${cfg.JVM_REGISTRY_NAME}).`);
  const clojureVersion = String(args.clojureVersion).toLowerCase() === "none" ? null : args.clojureVersion;
  const repoLocal = setupVenv(args.venvDir, clojureVersion, cfg, args.verbose);
  await testInstallations(repoLocal, args.package, indexUrl, versions, args.output, {
    firstOnly: args.firstOnly, cfg, verbose: args.verbose,
  });
  return 0;
}

// main() accepts an optional argv list. Pass one explicitly to drive the tool
// programmatically (e.g. from another script or a test); omit it and main()
// falls back to parseArgs(null), which reads from process.argv (normal CLI use).
//
// Example — probe the newest 5 versions of clojure, stop at the first resolvable:
//     main(["org.clojure:clojure", "--repo-url", "https://repo.clojars.org",
//           "--limit", "5", "--first-only"])
//
// Equivalent on the command line:
//     node main.mjs org.clojure:clojure \
//         --repo-url https://repo.clojars.org --limit 5 --first-only

import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then((code) => process.exit(code)); // argv=null -> parseArgs reads process.argv
}
