#!/usr/bin/env node
/**
 * Find installable versions of a Swift package from a git repository.
 *
 * Swift Package Manager packages are plain git repositories whose releases are
 * semver tags. This tool discovers every tag a repo advertises via
 * `git ls-remote --tags`, then attempts to resolve each one in an isolated
 * throwaway package (a temp `Package.swift` pinning `.exact("<ver>")`),
 * recording success/failure per version to a JSON report.
 *
 * Example:
 *     node main.mjs https://github.com/apple/swift-argument-parser.git
 *
 *     # only probe the newest 5 versions, stop at the first that resolves
 *     node main.mjs https://github.com/apple/swift-argument-parser.git \
 *         --limit 5 --first-only
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// swift version the test environment is pinned to by default. Resolve-tests run
// against this toolchain, so it governs resolver behaviour. Override via
// --swift-version (CLI) or the `swift` command (REPL). The swift toolchain is
// whatever is on PATH; this is informational (the OS/image selects it).
export const DEFAULT_SWIFT_VERSION = "6.0.3";

// Environment knobs read via process.env, each falling back to the value the
// Swift / git / TLS ecosystem uses by default ("industry standard"). git/swift
// read several of these from the environment; we resolve them explicitly so the
// documented default still applies when the var is unset, and so they can be
// surfaced (REPL `env`) and threaded into every git/swift invocation we build.
export const ENV_DEFAULTS = {
  SPM_VERBOSE: "0",                                   // swift: quiet (0 = no -v)
  GIT_TERMINAL_PROMPT: "0",                            // git: never prompt for creds
  GIT_HTTP_LOW_SPEED_TIME: "30",                       // git: abort a stalled fetch
  SWIFTPM_NETRC: "",                                   // swift: optional .netrc path
  SWIFT_REGISTRY_URL: "https://github.com",            // our repo-host fallback
  SWIFT_REGISTRY_NAME: "git (Swift Package Manager)",  // registry display name
  REQUESTS_CA_BUNDLE: "",                              // urllib/curl: certifi
  SSL_CERT_FILE: "",                                  // OpenSSL: system CA file
  SSL_CERT_DIR: "",                                   // OpenSSL: system CA dir
  GIT_SSL_CAINFO: "",                                 // git: explicit CA file
};

// TLS vars passed through to child processes via the environment (no CLI flag).
const TLS_ENV_VARS = ["REQUESTS_CA_BUNDLE", "SSL_CERT_FILE", "SSL_CERT_DIR", "GIT_SSL_CAINFO"];

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

/**
 * Pick the repo URL: explicit positional > SWIFT_REGISTRY_URL.
 *
 * For SPM the "registry" is the package's git repo URL itself, which is the
 * positional package argument. There is no separate index to fall back to, so
 * this exists mainly for symmetry with the reference's precedence chain.
 */
export function resolveIndexUrl(explicit, cfg = null) {
  cfg = cfg || resolveEnv();
  return explicit || cfg.SWIFT_REGISTRY_URL || null;
}

/** Translate resolved config into git/swift command-line flags. */
export function gitOptions(cfg) {
  const opts = [];
  let level = parseInt(cfg.SPM_VERBOSE, 10);
  if (Number.isNaN(level)) level = 0;
  if (level > 0) opts.push("--verbose"); // swift package --verbose
  return opts;
}

/** Child-process environment with resolved TLS/git cfg applied. */
export function subprocessEnv(cfg) {
  const env = { ...process.env };
  for (const name of TLS_ENV_VARS) {
    if (cfg[name]) env[name] = cfg[name];
  }
  // Thread git's non-interactive/network knobs through so every git child obeys them.
  env.GIT_TERMINAL_PROMPT = String(cfg.GIT_TERMINAL_PROMPT);
  if (cfg.GIT_HTTP_LOW_SPEED_TIME) env.GIT_HTTP_LOW_SPEED_TIME = String(cfg.GIT_HTTP_LOW_SPEED_TIME);
  if (cfg.SWIFTPM_NETRC) env.SWIFTPM_NETRC = cfg.SWIFTPM_NETRC;
  return env;
}

/**
 * Return the list of versions a repo advertises for `package`.
 *
 * For SPM the `package` is itself the git repo URL. We list tags via
 * `git ls-remote --tags`, strip the `^{}` peeled-tag suffix, keep only
 * semver-looking tags, and sort newest-first to match `pip`'s contract. When
 * `verbose` is set, the git command and its raw output are echoed so a failed or
 * empty discovery can be debugged.
 */
export function getAvailableVersions(pkg, indexUrl, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  const repoUrl = pkg; // the package IS the git repo URL for SPM
  console.log(`Retrieving versions for '${pkg}' from ${repoUrl}...`);
  const cmd = [
    "ls-remote",
    "--tags",
    repoUrl,
    ...gitOptions(cfg),
  ];
  if (verbose) console.log(`  $ git ${cmd.join(" ")}`);

  const res = spawnSync("git", cmd, { encoding: "utf8", env: subprocessEnv(cfg) });
  if (res.status !== 0) {
    if (verbose) echo(res.stdout, res.stderr);
    console.error(`Error running 'git ls-remote --tags': ${(res.stderr || "").trim()}`);
    process.exit(1);
  }

  if (verbose) echo(res.stdout);
  return parseSemverTags(res.stdout);
}

/**
 * Parse `git ls-remote --tags` output into semver versions, newest-first.
 *
 * Each line looks like `<sha>\trefs/tags/<tag>` (with a `^{}` suffix on the
 * peeled annotated-tag line). We drop the `^{}` lines, strip an optional leading
 * `v`, keep only tags that look like semver, and sort descending.
 */
export function parseSemverTags(text) {
  const versions = new Set();
  for (let line of (text || "").split(/\r?\n/)) {
    line = line.trim();
    if (!line) continue;
    const ref = line.split("\t").pop();
    if (!ref.startsWith("refs/tags/")) continue;
    let tag = ref.slice("refs/tags/".length);
    if (tag.endsWith("^{}")) {
      tag = tag.slice(0, -"^{}".length); // peeled annotated tag — dedupe via the set
    }
    const candidate = tag.toLowerCase().startsWith("v") ? tag.slice(1) : tag;
    if (/^\d+\.\d+(\.\d+)?([-+][0-9A-Za-z.-]+)?$/.test(candidate)) {
      versions.add(candidate);
    }
  }
  if (!versions.size) {
    console.error("Could not find any semver tags in 'git ls-remote' output.");
    return [];
  }
  return [...versions].sort((a, b) => semverCompare(b, a)); // newest-first
}

/** Sort key tuple: (major, minor, patch, release-rank) — release > pre-release. */
function semverKey(version) {
  const core = version.split(/[-+]/, 1)[0];
  const parts = core.split(".").map((p) => parseInt(p, 10)).concat([0, 0, 0]);
  // A pre-release (e.g. 1.0.0-beta) sorts below its release; rank 1 > 0.
  const rank = /[-]/.test(version) ? 0 : 1;
  return [parts[0], parts[1], parts[2], rank];
}

/** Compare two versions by their semver key (ascending). */
function semverCompare(a, b) {
  const ka = semverKey(a);
  const kb = semverKey(b);
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return ka[i] - kb[i];
  }
  return 0;
}

/**
 * Create a fresh throwaway package dir if needed; return its directory path.
 *
 * The sandbox is a temp package directory into which a per-version
 * `Package.swift` is written and resolved. The active toolchain is reported as
 * `swiftVersion` (default `DEFAULT_SWIFT_VERSION`) so resolve-tests run against
 * a known swift. Pass `swiftVersion=null` to keep whatever swift is on PATH.
 * `verbose` echoes the scaffold output so a failed setup can be debugged.
 */
export function setupVenv(envDir, swiftVersion = DEFAULT_SWIFT_VERSION, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  if (!fs.existsSync(envDir)) {
    console.log(`Creating throwaway package dir at: ${envDir}`);
    fs.mkdirSync(envDir, { recursive: true });
    // Minimal Sources tree so `swift package resolve` has a valid target.
    const src = path.join(envDir, "Sources", "verprobe");
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, "main.swift"), 'print("verprobe")\n');
  }

  if (swiftVersion) ensurePipVersion(envDir, swiftVersion, cfg, verbose);
  return envDir;
}

/** Report the active swift toolchain (PATH, not the package dir, owns it). */
function ensurePipVersion(envDir, swiftVersion, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  console.log(`Ensuring swift==${swiftVersion} in the test environment...`);
  const cmd = ["--version"];
  if (verbose) console.log(`  $ swift ${cmd.join(" ")}`);
  const res = spawnSync("swift", cmd, { encoding: "utf8", env: subprocessEnv(cfg) });
  if (verbose) echo(res.stdout, res.stderr);
  if (res.status !== 0) {
    console.error(
      `Warning: could not confirm swift==${swiftVersion}: ${lastLine(res.stderr) || "unknown error"}`,
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

/** True if `options` already carry a `--verbose`/`-v` flag. */
function hasVerbose(options) {
  return options.some((o) => o.startsWith("--verbose") || o === "-v");
}

/**
 * Run `cmd`, echoing combined output live while capturing it.
 *
 * Resolves to `[returncode, combinedOutput]`. Used in verbose mode so the user
 * watches swift in real time (e.g. a slow clone or a hang) yet the captured text
 * still feeds the JSON report.
 */
function stream(bin, cmd, env, cwd = null) {
  return new Promise((resolve) => {
    const proc = spawn(bin, cmd, { env, cwd: cwd || undefined, stdio: ["ignore", "pipe", "pipe"] });
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

const PACKAGE_SWIFT_TEMPLATE = `// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "verprobe",
    dependencies: [
        .package(url: "{repo_url}", exact: "{version}"),
    ],
    targets: [
        .executableTarget(name: "verprobe"),
    ]
)
`;

/** Write a per-version Package.swift pinning `.exact("<version>")`. */
function writePackageSwift(envDir, repoUrl, version) {
  const manifest = PACKAGE_SWIFT_TEMPLATE
    .replace("{repo_url}", repoUrl)
    .replace("{version}", version);
  fs.writeFileSync(path.join(envDir, "Package.swift"), manifest);
}

/**
 * Attempt to resolve each version; write an incremental JSON report.
 *
 * `pipPath` is the throwaway package directory from `setupVenv`; `package` is
 * the git repo URL. For each version we rewrite Package.swift to pin
 * `.exact("<ver>")` then run `swift package resolve`. Returns the list of result
 * objects. If `firstOnly` is set, stops after the first version that resolves
 * successfully. When `verbose` is set, swift's full output is streamed live (and
 * a `--verbose` flag is added if none is present) so resolve failures can be
 * debugged; the captured output is also folded into the report under
 * `log`/`error`.
 */
export async function testInstallations(pipPath, pkg, indexUrl, versions, outputJson, {
  firstOnly = false, cfg = null, verbose = false,
} = {}) {
  cfg = cfg || resolveEnv();
  const env = subprocessEnv(cfg);
  const options = gitOptions(cfg);
  const repoUrl = pkg; // the package IS the git repo URL for SPM
  const results = [];
  const installable = [];

  for (let idx = 0; idx < versions.length; idx++) {
    const version = versions[idx];
    const target = `${repoUrl}@${version}`;
    console.log(`[${idx + 1}/${versions.length}] Attempting to resolve: ${target}...`);

    // Rewrite the manifest each iteration to pin exactly this version, and
    // drop any stale lock so the resolver re-evaluates from scratch.
    writePackageSwift(pipPath, repoUrl, version);
    const lock = path.join(pipPath, "Package.resolved");
    if (fs.existsSync(lock)) fs.rmSync(lock);

    const cmd = [
      "package",
      "resolve",
      ...options,
    ];
    // Bump swift's verbosity if the user wants detail and nothing already set it.
    if (verbose && !hasVerbose(options)) cmd.push("--verbose");

    let returncode, stdoutText, stderrText;
    if (verbose) {
      console.log(`  $ (cd ${pipPath} && swift ${cmd.join(" ")})`);
      const [code, output] = await stream("swift", cmd, env, pipPath);
      returncode = code;
      stdoutText = stderrText = output; // streamed combined; same text both ways
    } else {
      const res = spawnSync("swift", cmd, { encoding: "utf8", env, cwd: pipPath });
      returncode = res.status;
      stdoutText = res.stdout;
      stderrText = res.stderr;
    }

    if (returncode === 0) {
      console.log(`  ✅ SUCCESS: ${target}`);
      results.push({
        version,
        status: "success",
        log: lastLine(stdoutText) || lastLine(stderrText),
      });
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
                [--swift-version SWIFT_VERSION] [--output OUTPUT]
                [--limit LIMIT] [--first-only] [-v] package

Find installable versions of a Swift package from a git repo.

positional arguments:
  package               Swift package git repo URL to probe
                        (e.g. https://github.com/apple/swift-argument-parser.git).

options:
  -h, --help            show this help message and exit
  --registry INDEX_URL  Repo host (informational; the package URL is the real
                        source). Defaults to $SWIFT_REGISTRY_URL, then
                        https://github.com.
  --venv-dir VENV_DIR   Directory for the isolated throwaway test package.
                        (default: .venv-test-install)
  --swift-version SWIFT_VERSION
                        swift version to assert in the test package ('none' to
                        keep the active toolchain). (default: ${DEFAULT_SWIFT_VERSION})
  --output OUTPUT       Path to write the JSON report.
                        (default: installation_report.json)
  --limit LIMIT         Only test the newest N versions (default: all).
  --first-only          Stop after the first version that resolves successfully.
  -v, --verbose         Stream full swift output for every step so failures are
                        debuggable.
`;

/** Parse a `main`-style argv list into an options object (mirrors argparse). */
export function parseArgs(argv = null) {
  argv = argv === null ? process.argv.slice(2) : argv;
  const args = {
    package: null,
    indexUrl: null,
    venvDir: ".venv-test-install",
    swiftVersion: DEFAULT_SWIFT_VERSION,
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
    } else if (a === "--swift-version") {
      args.swiftVersion = next();
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

  console.log(`Found ${versions.length} version(s) to test (registry: ${cfg.SWIFT_REGISTRY_NAME}).`);
  const swiftVersion = String(args.swiftVersion).toLowerCase() === "none" ? null : args.swiftVersion;
  const pipPath = setupVenv(args.venvDir, swiftVersion, cfg, args.verbose);
  await testInstallations(pipPath, args.package, indexUrl, versions, args.output, {
    firstOnly: args.firstOnly, cfg, verbose: args.verbose,
  });
  return 0;
}

// main() accepts an optional argv list. Pass one explicitly to drive the tool
// programmatically (e.g. from another script or a test); omit it and main()
// falls back to parseArgs(null), which reads from process.argv (normal CLI use).
//
// Example — probe the newest 5 versions of a package, stop at the first installable:
//     main(["https://github.com/apple/swift-argument-parser.git",
//           "--limit", "5", "--first-only"])
//
// Equivalent on the command line:
//     node main.mjs https://github.com/apple/swift-argument-parser.git \
//         --limit 5 --first-only

import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then((code) => process.exit(code)); // argv=null -> parseArgs reads process.argv
}
