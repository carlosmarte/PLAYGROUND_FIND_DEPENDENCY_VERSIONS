#!/usr/bin/env node
/**
 * Find resolvable versions of a dependency from a (custom) Maven repository.
 *
 * Discovers every version a repository advertises for a `groupId:artifactId`
 * coordinate via the artifact's `maven-metadata.xml` (Gradle consumes the same
 * Maven coordinate scheme), then attempts to resolve each one through a throwaway
 * Gradle project, recording success/failure per version to a JSON report.
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
import os from "node:os";
import path from "node:path";
import process from "node:process";

// gradle version the test environment is pinned to by default. Resolve-tests run
// against this gradle, so it governs resolver/repository behaviour. Override via
// --gradle-version (CLI) or the `gradle` command (REPL).
export const DEFAULT_GRADLE_VERSION = "8.10";

// Environment knobs read via process.env, each falling back to the value the
// Gradle / JVM ecosystem uses by default ("industry standard"). Gradle itself
// auto-reads options from the environment; we resolve them explicitly so the
// documented default still applies when the var is unset, and so they can be
// surfaced (REPL `env`) and threaded into every gradle invocation we build.
export const ENV_DEFAULTS = {
  GRADLE_VERBOSE: "0",                                 // gradle: quiet (0 = no --info)
  GRADLE_TRANSFER_TIMEOUT: "15",                       // gradle: 15s transfer timeout
  GRADLE_REPO_URL: "https://repo1.maven.org/maven2",   // gradle: remote repo base
  GRADLE_OPTS: "",                                     // gradle: extra JVM opts
  JVM_REGISTRY_URL: "https://repo1.maven.org/maven2",  // our repo-url fallback
  JVM_REGISTRY_NAME: "Maven Central",                  // registry display name
  GRADLE_USER_AGENT: "",                               // http: optional UA override
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

/** Pick the repo URL: explicit flag > GRADLE_REPO_URL > JVM_REGISTRY_URL. */
export function resolveIndexUrl(explicit, cfg = null) {
  cfg = cfg || resolveEnv();
  return explicit || cfg.GRADLE_REPO_URL || cfg.JVM_REGISTRY_URL || null;
}

/** Translate resolved config into gradle command-line flags. */
export function gradleOptions(cfg) {
  let opts = ["--quiet", "--console=plain"];
  const parsed = parseInt(cfg.GRADLE_VERBOSE, 10);
  const level = Number.isNaN(parsed) ? 0 : parsed;
  if (level > 0) {
    // Drop --quiet and surface gradle's --info detail instead.
    opts = ["--info", "--console=plain"];
  }
  return opts;
}

/** Child-process environment with resolved HTTP/proxy vars applied. */
export function subprocessEnv(cfg) {
  const env = { ...process.env };
  for (const name of TLS_ENV_VARS) {
    if (cfg[name]) env[name] = cfg[name];
  }
  if (cfg.GRADLE_OPTS) env.GRADLE_OPTS = cfg.GRADLE_OPTS;
  return env;
}

/** Split `groupId:artifactId` into a `[group, artifact]` pair. */
function splitCoordinate(pkg) {
  if (!pkg.includes(":")) {
    console.error(`Coordinate must be 'groupId:artifactId' (got ${JSON.stringify(pkg)}).`);
    process.exit(1);
  }
  const idx = pkg.indexOf(":");
  const group = pkg.slice(0, idx);
  const artifact = pkg.slice(idx + 1);
  return [group.trim(), artifact.trim()];
}

/**
 * Return the list of versions a repository advertises for `package`.
 *
 * Versions are returned newest-first, parsed from the artifact's
 * `maven-metadata.xml` (`<repo>/<group-as-path>/<artifact>/maven-metadata.xml`)
 * — Gradle resolves the very same Maven coordinates. When `verbose` is set, the
 * metadata URL and its raw body are echoed so a failed or empty discovery can be
 * debugged.
 */
export async function getAvailableVersions(pkg, indexUrl, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  const [group, artifact] = splitCoordinate(pkg);
  const base = (indexUrl || cfg.GRADLE_REPO_URL).replace(/\/+$/, "");
  const groupPath = group.replace(/\./g, "/");
  const url = `${base}/${groupPath}/${artifact}/maven-metadata.xml`;
  console.log(`Retrieving versions for '${pkg}' from ${url}...`);
  if (verbose) console.log(`  $ GET ${url}`);

  let body;
  try {
    const controller = new AbortController();
    const timeoutMs = parseInt(cfg.GRADLE_TRANSFER_TIMEOUT, 10) * 1000;
    const timer = setTimeout(() => controller.abort(), Number.isNaN(timeoutMs) ? 15000 : timeoutMs);
    try {
      const resp = await fetch(url, { signal: controller.signal });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      body = await resp.text();
    } finally {
      clearTimeout(timer);
    }
  } catch (e) { // any fetch failure is a hard discovery error
    console.error(`Error fetching maven-metadata.xml: ${e.message || e}`);
    process.exit(1);
  }

  if (verbose) echo(body);
  // <metadata><versioning><versions><version>...</version></versions></versioning>
  const matches = [...body.matchAll(/<version>([^<]*)<\/version>/g)];
  const versions = matches
    .map((m) => (m[1] || "").trim())
    .filter((v) => v);
  if (!versions.length) {
    console.error("Could not find any <version> elements in maven-metadata.xml.");
    return [];
  }
  // maven-metadata.xml lists oldest-first; reverse so newest leads (mirrors pip).
  return versions.reverse();
}

/**
 * Create a fresh isolated Gradle sandbox if needed; return its path.
 *
 * The sandbox is a throwaway directory used as both the scratch project dir
 * and `--gradle-user-home`, so every resolve-test fetches fresh into a known
 * location, isolated from the host's `~/.gradle`. `gradleVersion` is recorded
 * for parity with the reference (the test step runs against whatever `gradle`
 * is on PATH); pass `gradleVersion=null` to skip the version check. `verbose`
 * echoes the gradle-version output so a failed check can be debugged.
 */
export function setupVenv(envDir, gradleVersion = DEFAULT_GRADLE_VERSION, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  if (!fs.existsSync(envDir)) {
    console.log(`Creating Gradle sandbox at: ${envDir}`);
    fs.mkdirSync(envDir, { recursive: true });
  }

  if (gradleVersion) ensureGradleVersion(gradleVersion, cfg, verbose);
  // The "handle" the test step needs is just the sandbox path.
  return envDir;
}

/** Check the `gradle` on PATH and warn if it differs from `gradleVersion`. */
function ensureGradleVersion(gradleVersion, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  console.log(`Ensuring gradle==${gradleVersion} in the test environment...`);
  const cmd = ["--version"];
  if (verbose) console.log(`  $ gradle ${cmd.join(" ")}`);
  const res = spawnSync("gradle", cmd, { encoding: "utf8", env: subprocessEnv(cfg) });
  if (res.error && res.error.code === "ENOENT") {
    console.error(
      `Warning: could not pin gradle==${gradleVersion}: gradle not found on PATH`,
    );
    return;
  }
  if (verbose) echo(res.stdout, res.stderr);
  if (res.status !== 0 || !(res.stdout || "").includes(gradleVersion)) {
    console.error(
      `Warning: could not pin gradle==${gradleVersion}: ` +
      `${lastLine(res.stdout) || lastLine(res.stderr) || "unknown error"}`,
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

/** True if gradle `options` already carry an `--info` flag. */
function hasVerbose(options) {
  return options.some((o) => o === "--info");
}

/**
 * Run `gradle <cmd>`, echoing combined output live while capturing it.
 *
 * Resolves to `[returncode, combinedOutput]`. Used in verbose mode so the user
 * watches gradle in real time (e.g. a slow build or a hang) yet the captured
 * text still feeds the JSON report.
 */
function stream(cmd, env) {
  return new Promise((resolve) => {
    const proc = spawn("gradle", cmd, { env, stdio: ["ignore", "pipe", "pipe"] });
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
 * Write a tiny throwaway build.gradle declaring `implementation '<target>'`.
 *
 * A single `probe` configuration plus a `resolve` task forces Gradle to actually
 * fetch the dependency, which is what makes the returncode meaningful.
 */
function writeBuildGradle(projectDir, indexUrl, target) {
  const repo = indexUrl ? `maven { url '${indexUrl}' }` : "mavenCentral()";
  const build = `plugins { id 'base' }
repositories {
    ${repo}
    mavenCentral()
}
configurations { probe }
dependencies {
    probe '${target}'
}
task resolve {
    doLast { configurations.probe.resolve() }
}
`;
  fs.writeFileSync(path.join(projectDir, "build.gradle"), build);
  // An empty settings.gradle keeps Gradle from walking up to a parent build.
  fs.writeFileSync(path.join(projectDir, "settings.gradle"), "rootProject.name = 'gradle-versions-probe'\n");
}

/**
 * Attempt to resolve each version; write an incremental JSON report.
 *
 * For each version a tiny temp `build.gradle` is generated that declares the
 * dependency, then `gradle resolve --refresh-dependencies` forces a fetch.
 * Returns the list of result objects. If `firstOnly` is set, stops after the
 * first version that resolves successfully. When `verbose` is set, gradle's
 * full output is streamed live (and an `--info` flag is added if none is
 * present) so resolution failures can be debugged; the captured output is also
 * folded into the report under `log`/`error`.
 */
export async function testInstallations(sandbox, pkg, indexUrl, versions, outputJson, {
  firstOnly = false, cfg = null, verbose = false,
} = {}) {
  cfg = cfg || resolveEnv();
  const env = subprocessEnv(cfg);
  const options = gradleOptions(cfg);
  const [group, artifact] = splitCoordinate(pkg);
  const results = [];
  const installable = [];

  for (let idx = 0; idx < versions.length; idx++) {
    const version = versions[idx];
    const target = `${group}:${artifact}:${version}`;
    console.log(`[${idx + 1}/${versions.length}] Attempting to resolve: ${target}...`);

    // Each version gets its own scratch project so build.gradle never clashes.
    const projectDir = fs.mkdtempSync(path.join(sandbox, "gradle-probe-"));
    writeBuildGradle(projectDir, indexUrl, target);

    const cmd = [
      "resolve",
      "--refresh-dependencies",
      `--gradle-user-home=${sandbox}`,
      `--project-dir=${projectDir}`,
    ];
    cmd.push(...options);
    // Bump gradle's own verbosity if the user wants detail and nothing already set it.
    if (verbose && !hasVerbose(options)) cmd.push("--info");

    let returncode, stdoutText, stderrText;
    if (verbose) {
      console.log(`  $ gradle ${cmd.join(" ")}`);
      const [code, output] = await stream(cmd, env);
      returncode = code;
      stdoutText = stderrText = output; // streamed combined; same text both ways
    } else {
      const res = spawnSync("gradle", cmd, { encoding: "utf8", env });
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
                [--gradle-version GRADLE_VERSION] [--output OUTPUT]
                [--limit LIMIT] [--first-only] [-v] package

Find resolvable versions of a dependency from a Maven repository (via Gradle).

positional arguments:
  package               Coordinate to probe as groupId:artifactId (e.g.
                        com.google.guava:guava).

options:
  -h, --help            show this help message and exit
  --repo-url REPO_URL   Custom Maven repository base URL. Defaults to
                        $GRADLE_REPO_URL, then $JVM_REGISTRY_URL, then
                        https://repo1.maven.org/maven2.
  --venv-dir VENV_DIR   Directory for the isolated Gradle sandbox / user home.
                        (default: .gradle-test-home)
  --gradle-version GRADLE_VERSION
                        gradle version to verify in the test environment ('none'
                        to skip the check). (default: ${DEFAULT_GRADLE_VERSION})
  --output OUTPUT       Path to write the JSON report.
                        (default: installation_report.json)
  --limit LIMIT         Only test the newest N versions (default: all).
  --first-only          Stop after the first version that resolves successfully.
  -v, --verbose         Stream full gradle output for every step so failures are
                        debuggable.
`;

/** Parse a `main`-style argv list into an options object (mirrors argparse). */
export function parseArgs(argv = null) {
  argv = argv === null ? process.argv.slice(2) : argv;
  const args = {
    package: null,
    repoUrl: null,
    venvDir: ".gradle-test-home",
    gradleVersion: DEFAULT_GRADLE_VERSION,
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
    } else if (a === "--gradle-version") {
      args.gradleVersion = next();
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
  const gradleVersion = String(args.gradleVersion).toLowerCase() === "none" ? null : args.gradleVersion;
  const sandbox = setupVenv(args.venvDir, gradleVersion, cfg, args.verbose);
  await testInstallations(sandbox, args.package, indexUrl, versions, args.output, {
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
