#!/usr/bin/env node
/**
 * Find resolvable versions of an artifact from a (custom) Maven repository.
 *
 * Discovers every version a repository advertises for a `groupId:artifactId`
 * coordinate via the artifact's `maven-metadata.xml`, then attempts to resolve
 * each one into an isolated local Maven repository, recording success/failure per
 * version to a JSON report.
 *
 * Example:
 *     node main.mjs com.google.guava:guava \
 *         --repo-url https://repo1.maven.org/maven2
 *
 *     # only probe the newest 5 versions, stop at the first that resolves
 *     node main.mjs com.google.guava:guava --repo-url https://repo/maven2 \
 *         --limit 5 --first-only
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// maven version the test environment is pinned to by default. Resolve-tests run
// against this maven, so it governs resolver/repository behaviour. Override via
// --maven-version (CLI) or the `maven` command (REPL).
export const DEFAULT_MAVEN_VERSION = "3.9.9";

// Environment knobs read via process.env, each falling back to the value the
// Maven / JVM ecosystem uses by default ("industry standard"). Maven itself
// auto-reads settings from the environment; we resolve them explicitly so the
// documented default still applies when the var is unset, and so they can be
// surfaced (REPL `env`) and threaded into every mvn invocation we build.
export const ENV_DEFAULTS = {
  MAVEN_VERBOSE: "0",                                  // mvn: quiet (0 = no -X)
  MAVEN_TRANSFER_TIMEOUT: "15",                        // mvn: 15s transfer timeout
  MAVEN_REPO_URL: "https://repo1.maven.org/maven2",    // mvn: remote repo base
  MAVEN_OPTS: "",                                      // mvn: extra JVM opts
  JVM_REGISTRY_URL: "https://repo1.maven.org/maven2",  // our repo-url fallback
  JVM_REGISTRY_NAME: "Maven Central",                  // registry display name
  MAVEN_USER_AGENT: "",                                // http: optional UA override
  HTTPS_PROXY: "",                                     // http: optional proxy
  HTTP_PROXY: "",                                      // http: optional proxy
  NO_PROXY: "",                                        // http: proxy bypass list
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

/** Pick the repo URL: explicit flag > MAVEN_REPO_URL > JVM_REGISTRY_URL. */
export function resolveIndexUrl(explicit, cfg = null) {
  cfg = cfg || resolveEnv();
  return explicit || cfg.MAVEN_REPO_URL || cfg.JVM_REGISTRY_URL || null;
}

/** Translate resolved config into mvn command-line flags. */
export function mavenOptions(cfg) {
  const opts = [];
  let level = parseInt(cfg.MAVEN_VERBOSE, 10);
  if (Number.isNaN(level)) level = 0;
  if (level > 0) opts.push("-X");  // maven debug output
  // Bound the remote transfer so a hung mirror fails fast rather than blocking.
  opts.push("-Dmaven.wagon.httpconnectionManager.ttlSeconds=" + String(cfg.MAVEN_TRANSFER_TIMEOUT));
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

/** Split `groupId:artifactId` into a `[group, artifact]` pair. */
function splitCoordinate(pkg) {
  if (!pkg.includes(":")) {
    console.error(`Coordinate must be 'groupId:artifactId' (got '${pkg}').`);
    process.exit(1);
  }
  const idx = pkg.indexOf(":");
  const group = pkg.slice(0, idx);
  const artifact = pkg.slice(idx + 1);
  return [group.trim(), artifact.trim()];
}

/** Pull the text of every `<version>` element out of a maven-metadata.xml body. */
function parseVersions(body) {
  const versions = [];
  const re = /<version>([\s\S]*?)<\/version>/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const text = m[1].trim();
    if (text) versions.push(text);
  }
  return versions;
}

/**
 * Return the list of versions a repository advertises for `pkg`.
 *
 * Versions are returned newest-first, parsed from the artifact's
 * `maven-metadata.xml` (`<repo>/<group-as-path>/<artifact>/maven-metadata.xml`).
 * When `verbose` is set, the metadata URL and its raw body are echoed so a failed
 * or empty discovery can be debugged.
 */
export async function getAvailableVersions(pkg, indexUrl, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  const [group, artifact] = splitCoordinate(pkg);
  const base = (indexUrl || cfg.MAVEN_REPO_URL).replace(/\/+$/, "");
  const groupPath = group.replace(/\./g, "/");
  const url = `${base}/${groupPath}/${artifact}/maven-metadata.xml`;
  console.log(`Retrieving versions for '${pkg}' from ${url}...`);
  if (verbose) console.log(`  $ GET ${url}`);

  let body;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(parseInt(cfg.MAVEN_TRANSFER_TIMEOUT, 10) * 1000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    body = await resp.text();
  } catch (e) {  // any fetch failure is a hard discovery error
    console.error(`Error fetching maven-metadata.xml: ${e.message || e}`);
    process.exit(1);
  }

  if (verbose) echo(body);
  // <metadata><versioning><versions><version>...</version></versions></versioning>
  const versions = parseVersions(body);
  if (!versions.length) {
    console.error("Could not find any <version> elements in maven-metadata.xml.");
    return [];
  }
  // maven-metadata.xml lists oldest-first; reverse so newest leads (mirrors pip).
  return versions.reverse();
}

/**
 * Create a fresh isolated local Maven repository if needed; return its path.
 *
 * The sandbox is a throwaway directory used as `-Dmaven.repo.local` so every
 * resolve-test fetches fresh into a known location, isolated from the host's
 * `~/.m2`. `mavenVersion` is recorded for parity with the reference (the test
 * step runs against whatever `mvn` is on PATH); pass `mavenVersion=null` to skip
 * the version check. `verbose` echoes the maven-version output so a failed check
 * can be debugged.
 */
export function setupVenv(envDir, mavenVersion = DEFAULT_MAVEN_VERSION, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  if (!fs.existsSync(envDir)) {
    console.log(`Creating local Maven repository at: ${envDir}`);
    fs.mkdirSync(envDir, { recursive: true });
  }

  if (mavenVersion) ensureMavenVersion(mavenVersion, cfg, verbose);
  // The "handle" the test step needs is just the local-repo path.
  return envDir;
}

/** Check the `mvn` on PATH and warn if it differs from `mavenVersion`. */
function ensureMavenVersion(mavenVersion, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  console.log(`Ensuring maven==${mavenVersion} in the test environment...`);
  const cmd = ["--version"];
  if (verbose) console.log(`  $ mvn ${cmd.join(" ")}`);
  const res = spawnSync("mvn", cmd, {
    encoding: "utf8",
    env: subprocessEnv(cfg),
    maxBuffer: 50 * 1024 * 1024, // defensive guard against future verbose output
  });
  if (res.error && res.error.code === "ENOENT") {
    console.error(`Warning: could not pin maven==${mavenVersion}: mvn not found on PATH`);
    return;
  }
  if (verbose) echo(res.stdout, res.stderr);
  if (res.status !== 0 || !(res.stdout || "").includes(mavenVersion)) {
    // status is null when the child was killed by a signal — output is empty in
    // that case, so fall back to the signal name / spawn error rather than blank.
    const detail = lastLine(res.stdout) || lastLine(res.stderr)
      || (res.signal && `terminated by signal ${res.signal}`)
      || (res.error && res.error.message)
      || "unknown error";
    console.error(
      `Warning: could not pin maven==${mavenVersion}: ${detail}`,
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

/** True if mvn `options` already carry a `-X` debug flag. */
function hasVerbose(options) {
  return options.some((o) => o === "-X");
}

/**
 * Run `mvn <cmd>`, echoing combined output live while capturing it.
 *
 * Resolves to `[returncode, combined_output]`. Used in verbose mode so the user
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
    proc.on("close", (code) => resolve([code ?? 0, chunks.join("")]));
  });
}

/**
 * Attempt to resolve each version; write an incremental JSON report.
 *
 * Returns the list of result objects. If `firstOnly` is set, stops after the
 * first version that resolves successfully. When `verbose` is set, mvn's full
 * output is streamed live (and a `-X` flag is added if none is present) so
 * resolution failures can be debugged; the captured output is also folded into
 * the report under `log`/`error`.
 */
export async function testInstallations(repoLocal, pkg, indexUrl, versions, outputJson, {
  firstOnly = false, cfg = null, verbose = false,
} = {}) {
  cfg = cfg || resolveEnv();
  const env = subprocessEnv(cfg);
  const options = mavenOptions(cfg);
  const [group, artifact] = splitCoordinate(pkg);
  const results = [];
  const installable = [];

  for (let idx = 0; idx < versions.length; idx++) {
    const version = versions[idx];
    const target = `${group}:${artifact}:${version}`;
    console.log(`[${idx + 1}/${versions.length}] Attempting to resolve: ${target}...`);

    const cmd = [
      "dependency:get",
      `-Dartifact=${target}`,
      `-Dmaven.repo.local=${repoLocal}`,
    ];
    if (indexUrl) cmd.push(`-DremoteRepositories=central::::${indexUrl}`);
    cmd.push(...options);
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
                [--maven-version MAVEN_VERSION] [--output OUTPUT] [--limit LIMIT]
                [--first-only] [-v] package

Find resolvable versions of an artifact from a Maven repository.

positional arguments:
  package               Coordinate to probe as groupId:artifactId (e.g.
                        com.google.guava:guava).

options:
  -h, --help            show this help message and exit
  --repo-url REPO_URL   Custom Maven repository base URL. Defaults to
                        $MAVEN_REPO_URL, then $JVM_REGISTRY_URL, then
                        https://repo1.maven.org/maven2.
  --venv-dir VENV_DIR   Directory for the isolated local Maven repository.
                        (default: .m2-test-repo)
  --maven-version MAVEN_VERSION
                        maven version to verify in the test environment ('none'
                        to skip the check). (default: ${DEFAULT_MAVEN_VERSION})
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
    mavenVersion: DEFAULT_MAVEN_VERSION,
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
    } else if (a === "--maven-version") {
      args.mavenVersion = next();
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
  const mavenVersion = String(args.mavenVersion).toLowerCase() === "none" ? null : args.mavenVersion;
  const repoLocal = setupVenv(args.venvDir, mavenVersion, cfg, args.verbose);
  await testInstallations(repoLocal, args.package, indexUrl, versions, args.output, {
    firstOnly: args.firstOnly, cfg, verbose: args.verbose,
  });
  return 0;
}

// main() accepts an optional argv list. Pass one explicitly to drive the tool
// programmatically (e.g. from another script or a test); omit it and main()
// falls back to parseArgs(null), which reads from process.argv (normal CLI use).
//
// Example — probe the newest 5 versions of guava, stop at the first resolvable:
//     main(["com.google.guava:guava", "--repo-url", "https://repo1.maven.org/maven2",
//           "--limit", "5", "--first-only"])
//
// Equivalent on the command line:
//     node main.mjs com.google.guava:guava \
//         --repo-url https://repo1.maven.org/maven2 --limit 5 --first-only

import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then((code) => process.exit(code)); // argv=null -> parseArgs reads process.argv
}
