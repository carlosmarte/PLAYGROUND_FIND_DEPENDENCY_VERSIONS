#!/usr/bin/env node
/**
 * Find installable versions of a package from a (custom) Arch pacman repository.
 *
 * Discovers every version a repository advertises for a package via
 * `pacman -Si` (current) plus the Arch Linux archive (historical), then attempts
 * to download each one into an isolated cache directory (`pacman -Sw --cachedir`),
 * recording success/failure per version to a JSON report.
 *
 * Example:
 *     node main.mjs bash \
 *         --repository https://archive.archlinux.org
 *
 *     # only probe the newest 5 versions, stop at the first that downloads
 *     node main.mjs bash --repository https://archive.archlinux.org \
 *         --limit 5 --first-only
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// pacman version the test environment is pinned to by default. Install-tests run
// against this pacman, so it governs resolver/cache behaviour. Override via
// --pacman-version (CLI) or the `pacman` command (REPL). pacman has no in-place
// "pin yourself to version X" command, so this constant is advisory: we record
// it, surface it, and warn if the host pacman differs.
export const DEFAULT_PACMAN_VERSION = "6.1.0";

// Base URL of the Arch Linux package archive (historical versions live here as
// downloadable package files; the current repo only advertises the latest).
export const ARCH_ARCHIVE_BASE = "https://archive.archlinux.org/packages";

// Environment knobs read via process.env, each falling back to the value the
// Arch / pacman ecosystem uses by default ("industry standard"). pacman itself
// reads some of these from the environment; we resolve them explicitly so the
// documented default still applies when the var is unset, and so they can be
// surfaced (REPL `env`) and threaded into every pacman invocation we build.
export const ENV_DEFAULTS = {
  PACMAN_VERBOSE: "0",                                // pacman: quiet (0 = no --debug)
  PACMAN_CERT: "",                                    // pacman: use system CA store
  PACMAN_INDEX: "https://archive.archlinux.org",      // pacman: archive base
  PACMAN_REPOSITORY: "https://archive.archlinux.org", // pacman: repo / mirror base
  PACMAN_TRUSTED_HOST: "",                            // pacman: no extra trusted hosts
  PACMAN_DEFAULT_TIMEOUT: "15",                       // pacman: download timeout (s)
  PACMAN_RETRIES: "5",                              // pacman: download retries
  PACMAN_REGISTRY_URL: "https://archive.archlinux.org",  // our repo fallback
  PACMAN_REGISTRY_NAME: "Arch",                      // registry display name
  REQUESTS_CA_BUNDLE: "",                            // requests/urllib3: certifi
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

/** Pick the repo URL: explicit flag > PACMAN_REPOSITORY > PACMAN_REGISTRY_URL. */
export function resolveIndexUrl(explicit, cfg = null) {
  cfg = cfg || resolveEnv();
  return explicit || cfg.PACMAN_REPOSITORY || cfg.PACMAN_REGISTRY_URL || null;
}

/** Translate resolved config into pacman command-line flags. */
export function pacmanOptions(cfg) {
  const opts = [];
  let level = parseInt(cfg.PACMAN_VERBOSE, 10);
  if (Number.isNaN(level)) level = 0;
  if (level > 0) opts.push("--debug");  // pacman's closest thing to -v (no -vv ladder)
  // pacman has no per-invocation timeout/retry flags the way pip does, but we
  // keep the same translation shape so the config surface mirrors the reference
  // even where pacman ignores a value.
  if (cfg.PACMAN_TRUSTED_HOST) opts.push("--config", cfg.PACMAN_TRUSTED_HOST);
  return opts;
}

/** Child-process environment with resolved TLS cert vars applied. */
export function subprocessEnv(cfg) {
  const env = { ...process.env };
  for (const name of TLS_ENV_VARS) {
    if (cfg[name]) env[name] = cfg[name];
  }
  if (cfg.PACMAN_CERT) env.PACMAN_CERT = cfg.PACMAN_CERT;
  return env;
}

/**
 * Return the list of versions a repository advertises for `pkg`.
 *
 * Versions are returned newest-first. The current `pacman -Si <pkg>` only
 * advertises the latest version, so historical versions are scraped from the
 * Arch archive directory listing at `<base>/packages/<first-letter>/<pkg>/`,
 * parsing the package-file links. The two sources are merged and sorted
 * newest-first via `vercmp`. When `verbose` is set, the commands/URLs and raw
 * output are echoed so a failed or empty discovery can be debugged.
 */
export async function getAvailableVersions(pkg, indexUrl, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  console.log(`Retrieving versions for '${pkg}' from ${indexUrl}...`);
  const versions = [];

  // 1) Current version via `pacman -Si` (best-effort; may be unavailable).
  // Strip any `--debug` from PACMAN_VERBOSE for this query: we only parse the
  // single "Version :" line, but `--debug` pacman emits a flood of output —
  // enough to overflow spawnSync's default 1MB buffer, which kills the child
  // (status=null) and yields empty output.
  const cmd = ["-Si", pkg, ...stripVerbose(pacmanOptions(cfg))];
  if (verbose) console.log(`  $ pacman ${cmd.join(" ")}`);
  const result = spawnSync("pacman", cmd, {
    encoding: "utf8",
    env: subprocessEnv(cfg),
    maxBuffer: 50 * 1024 * 1024, // defensive guard against future verbose output
  });
  if (result.error && result.error.code === "ENOENT") {
    if (verbose) console.log("  (pacman not on PATH; relying on the archive only)");
  } else {
    if (verbose) echo(result.stdout, result.stderr);
    // status is null when the child was killed by a signal (e.g. spawnSync
    // SIGTERM on buffer overflow) — output is empty in that case, so surface
    // the signal name / spawn error so the failure isn't silently swallowed.
    if (result.status !== 0 && !(result.stdout || "").trim()) {
      const detail = (result.stderr || "").trim()
        || (result.signal && `terminated by signal ${result.signal}`)
        || (result.error && result.error.message)
        || "unknown error";
      if (verbose) console.log(`  (pacman -Si failed: ${detail})`);
    }
    const m = (result.stdout || "").match(/^Version\s*:\s*(\S+)/m);
    if (m) versions.push(m[1]);
  }

  // 2) Historical versions from the Arch archive directory listing.
  const first = pkg[0].toLowerCase();
  const listingUrl = `${ARCH_ARCHIVE_BASE}/${first}/${pkg}/`;
  if (verbose) console.log(`  GET ${listingUrl}`);
  try {
    const timeout = parseFloat(cfg.PACMAN_DEFAULT_TIMEOUT) * 1000;
    const resp = await fetch(listingUrl, {
      headers: { "User-Agent": "pacman-versions" },
      signal: AbortSignal.timeout(timeout),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const html = await resp.text();
    if (verbose) echo(html.slice(0, 2000));
    // Archive files are named <pkg>-<version>-<arch>.pkg.tar.zst (skip the .sig
    // signatures). Capture the <version> between the package name and the
    // trailing -<arch>.pkg.tar.* suffix.
    const pat = new RegExp(
      escapeRegExp(pkg) +
      `-([^/"]+?)-(?:x86_64|any|i686|aarch64)\\.pkg\\.tar\\.[a-z]+(?:")`,
      "g",
    );
    let mm;
    while ((mm = pat.exec(html)) !== null) {
      const v = mm[1];
      if (!versions.includes(v)) versions.push(v);
    }
  } catch (e) {
    if (verbose) console.log(`  (archive listing failed: ${e.message || e})`);
  }

  if (!versions.length) {
    console.error("Could not find any versions from pacman or the Arch archive.");
    return [];
  }
  // Dedupe preserving order, then sort newest-first via pacman's own vercmp.
  const seen = [];
  for (const v of versions) {
    if (!seen.includes(v)) seen.push(v);
  }
  return sortVersionsNewestFirst(seen, cfg);
}

/** Escape a string for literal use inside a RegExp (mirrors re.escape). */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Sort pacman version strings newest-first using `vercmp` when available.
 *
 * pacman version ordering (epochs, `pkgrel` suffixes) is non-trivial, so we ask
 * `vercmp` (ships with pacman) to compare pairs; if it is unavailable we fall
 * back to a plain reverse string sort so discovery still degrades gracefully.
 */
function sortVersionsNewestFirst(versions, cfg = null) {
  cfg = cfg || resolveEnv();

  const cmp = (a, b) => {
    const res = spawnSync("vercmp", [a, b], {
      encoding: "utf8",
      env: subprocessEnv(cfg),
      maxBuffer: 50 * 1024 * 1024, // defensive guard against future verbose output
    });
    if (res.error && res.error.code === "ENOENT") {
      return (a > b ? 1 : 0) - (a < b ? 1 : 0);
    }
    const token = (res.stdout || "").trim();
    const n = parseInt(token, 10);  // vercmp prints -1 / 0 / 1
    if (Number.isNaN(n)) return (a > b ? 1 : 0) - (a < b ? 1 : 0);
    return n;
  };

  // sorted(..., reverse=True): negate the comparator to flip the order.
  return versions.slice().sort((a, b) => -cmp(a, b));
}

/**
 * Create a fresh isolated cache dir if needed; return its path.
 *
 * The "isolated test env" for pacman is a throwaway cache directory targeted via
 * `--cachedir <dir>` — the analog of pip's venv. Download-tests write packages
 * there so the host system stays untouched. `pacmanVersion` is advisory (pacman
 * cannot re-pin itself in place): when set we verify the host pacman matches and
 * `verbose` echoes the check. Pass `pacmanVersion=null` to skip the check
 * entirely.
 */
export function setupVenv(envDir, pacmanVersion = DEFAULT_PACMAN_VERSION, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  if (!fs.existsSync(envDir)) {
    console.log(`Creating isolated pacman cache dir at: ${envDir}`);
    fs.mkdirSync(envDir, { recursive: true });
  }

  // The "handle" the test step needs is the cache directory itself.
  const cachePath = envDir;

  if (pacmanVersion) ensurePacmanVersion(pacmanVersion, cfg, verbose);
  return cachePath;
}

/** Verify the host pacman matches `pacmanVersion` (advisory only). */
function ensurePacmanVersion(pacmanVersion, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  console.log(`Ensuring pacman==${pacmanVersion} in the test environment...`);
  const cmd = ["--version"];
  if (verbose) console.log(`  $ pacman ${cmd.join(" ")}`);
  const res = spawnSync("pacman", cmd, {
    encoding: "utf8",
    env: subprocessEnv(cfg),
    maxBuffer: 50 * 1024 * 1024, // defensive guard against future verbose output
  });
  if (verbose) echo(res.stdout, res.stderr);
  let have = "";
  for (const line of (res.stdout || "").split(/\r?\n/)) {
    const m = line.match(/Pacman v?(\S+)/);
    if (m) {
      have = m[1];
      break;
    }
  }
  if (res.status !== 0) {
    console.error(
      `Warning: could not query pacman version ` +
      `(wanted ${pacmanVersion}): ${lastLine(res.stderr) || "unknown error"}`,
    );
  } else if (have && !have.includes(pacmanVersion)) {
    console.error(
      `Warning: host pacman is '${have}', not ${pacmanVersion} ` +
      `(pacman cannot re-pin itself in place).`,
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

/** True if pacman `options` already carry a `--debug` flag. */
function hasVerbose(options) {
  return options.some((o) => o === "--debug");
}

/** pacman `options` with any `--debug` verbosity flag removed. */
function stripVerbose(options) {
  return options.filter((o) => o !== "--debug");
}

/**
 * Run `pacman <cmd>`, echoing combined output live while capturing it.
 *
 * Resolves to `[returncode, combined_output]`. Used in verbose mode so the user
 * watches pacman in real time (e.g. a slow fetch or a hang) yet the captured
 * text still feeds the JSON report.
 */
function stream(cmd, env) {
  return new Promise((resolve) => {
    const proc = spawn("pacman", cmd, { env, stdio: ["ignore", "pipe", "pipe"] });
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
 * Attempt to download each version; write an incremental JSON report.
 *
 * Each version is downloaded into a *fresh* throwaway cache (so versions do not
 * interfere with one another), via `pacman -Sw --noconfirm --cachedir <tmp>
 * <pkg>`. pacman's configured repos only carry the current version, so a
 * specific historical version is resolved by handing pacman the archive URL of
 * that exact package file when it is not the current one. Returns the list of
 * result objects. If `firstOnly` is set, stops after the first version that
 * downloads successfully. When `verbose` is set, pacman's full output is
 * streamed live (and a `--debug` flag is added if none is present) so failures
 * can be debugged; the captured output is also folded into the report under
 * `log`/`error`.
 */
export async function testInstallations(cachePath, pkg, indexUrl, versions, outputJson, {
  firstOnly = false, cfg = null, verbose = false,
} = {}) {
  cfg = cfg || resolveEnv();
  const env = subprocessEnv(cfg);
  const options = pacmanOptions(cfg);
  const results = [];
  const installable = [];
  const first = pkg[0].toLowerCase();

  for (let idx = 0; idx < versions.length; idx++) {
    const version = versions[idx];
    const target = `${pkg}=${version}`;
    console.log(`[${idx + 1}/${versions.length}] Attempting to install: ${target}...`);

    // Per-version throwaway cache keeps downloads independent and crash-safe.
    const tmpCache = fs.mkdtempSync(path.join(cachePath, "pacman-test-"));
    // A specific version lives in the archive as a downloadable package file;
    // hand pacman that URL so it fetches exactly that version into the cache.
    const archiveUrl =
      `${ARCH_ARCHIVE_BASE}/${first}/${pkg}/` +
      `${pkg}-${version}-x86_64.pkg.tar.zst`;
    const cmd = [
      "-Sw",
      "--noconfirm",
      "--cachedir",
      tmpCache,
      archiveUrl,
    ];
    cmd.push(...options);
    // Bump pacman's own verbosity if the user wants detail and nothing already set it.
    if (verbose && !hasVerbose(options)) cmd.push("--debug");

    let returncode, stdoutText, stderrText;
    if (verbose) {
      console.log(`  $ pacman ${cmd.join(" ")}`);
      const [code, output] = await stream(cmd, env);
      returncode = code;
      stdoutText = stderrText = output; // streamed combined; same text both ways
    } else {
      const res = spawnSync("pacman", cmd, {
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

const HELP = `usage: main.mjs [-h] [--repository INDEX_URL] [--venv-dir VENV_DIR]
                [--pacman-version PACMAN_VERSION] [--output OUTPUT] [--limit LIMIT]
                [--first-only] [-v] package

Find installable versions of a package from an Arch pacman repository.

positional arguments:
  package               Package name to probe (e.g. bash).

options:
  -h, --help            show this help message and exit
  --repository, --index-url INDEX_URL
                        Custom pacman repo/archive base URL. Defaults to
                        $PACMAN_REPOSITORY, then $PACMAN_REGISTRY_URL, then the
                        Arch archive.
  --venv-dir VENV_DIR   Directory for the isolated pacman cache(s).
                        (default: .pacman-test-install)
  --pacman-version PACMAN_VERSION
                        pacman version to expect in the test env ('none' to skip
                        the check). (default: ${DEFAULT_PACMAN_VERSION})
  --output OUTPUT       Path to write the JSON report.
                        (default: installation_report.json)
  --limit LIMIT         Only test the newest N versions (default: all).
  --first-only          Stop after the first version that installs successfully.
  -v, --verbose         Stream full pacman output for every step so failures are
                        debuggable.
`;

/** Parse a `main`-style argv list into an options object (mirrors argparse). */
export function parseArgs(argv = null) {
  argv = argv === null ? process.argv.slice(2) : argv;
  const args = {
    package: null,
    indexUrl: null,
    venvDir: ".pacman-test-install",
    pacmanVersion: DEFAULT_PACMAN_VERSION,
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
    } else if (a === "--repository" || a === "--index-url") {
      args.indexUrl = next();
    } else if (a === "--venv-dir") {
      args.venvDir = next();
    } else if (a === "--pacman-version") {
      args.pacmanVersion = next();
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

  console.log(`Found ${versions.length} version(s) to test (registry: ${cfg.PACMAN_REGISTRY_NAME}).`);
  const pacmanVersion = String(args.pacmanVersion).toLowerCase() === "none" ? null : args.pacmanVersion;
  const cachePath = setupVenv(args.venvDir, pacmanVersion, cfg, args.verbose);
  await testInstallations(cachePath, args.package, indexUrl, versions, args.output, {
    firstOnly: args.firstOnly, cfg, verbose: args.verbose,
  });
  return 0;
}

// main() accepts an optional argv list. Pass one explicitly to drive the tool
// programmatically (e.g. from another script or a test); omit it and main()
// falls back to parseArgs(null), which reads from process.argv (normal CLI use).
//
// Example — probe the newest 5 versions of bash, stop at the first installable:
//     main(["bash", "--repository", "https://archive.archlinux.org",
//           "--limit", "5", "--first-only"])
//
// Equivalent on the command line:
//     node main.mjs bash \
//         --repository https://archive.archlinux.org --limit 5 --first-only

import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then((code) => process.exit(code)); // argv=null -> parseArgs reads process.argv
}
