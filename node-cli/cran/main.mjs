#!/usr/bin/env node
/**
 * Find installable versions of a package from a (custom) CRAN registry.
 *
 * Discovers every version a registry advertises for a package via the CRAN
 * database HTTP JSON API (`https://crandb.r-pkg.org/<pkg>/all`), then attempts
 * to install each one in an isolated R library directory, recording
 * success/failure per version to a JSON report.
 *
 * Example:
 *     node main.mjs jsonlite \
 *         --repos https://cloud.r-project.org
 *
 *     # only probe the newest 5 versions, stop at the first that installs
 *     node main.mjs jsonlite --repos https://cloud.r-project.org \
 *         --limit 5 --first-only
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// R version the test environment is pinned to by default. Install-tests run
// against this R, so it governs resolver/build behaviour. Override via
// --r-version (CLI) or the `r` command (REPL). Note: R itself is provided by the
// host toolchain; we only record the pin we expect (remotes drives the install).
export const DEFAULT_R_VERSION = "4.4.2";

// Environment knobs read via process.env, each falling back to the value the
// R / CRAN ecosystem uses by default ("industry standard"). R's install tooling
// (`remotes::install_version`) reads repository and TLS settings from the
// environment; we resolve them explicitly so the documented default still
// applies when the var is unset, and so they can be surfaced (REPL `env`) and
// threaded into every Rscript invocation we build.
export const ENV_DEFAULTS = {
  R_VERBOSE: "0",                                // R: quiet (0 = no extra noise)
  R_LIBS_USER: "",                               // R: extra user library path
  CRAN_DB_URL: "https://crandb.r-pkg.org",       // crandb: version-listing API base
  R_REPOS_URL: "https://cloud.r-project.org",    // R: PEP-style CRAN mirror (repos=)
  R_DEFAULT_TIMEOUT: "60",                        // R: download.file.method timeout (s)
  R_DOWNLOAD_RETRIES: "5",                        // remotes: download retries
  R_REGISTRY_URL: "https://cloud.r-project.org",  // our repos fallback
  R_REGISTRY_NAME: "CRAN",                       // registry display name
  CURL_CA_BUNDLE: "",                            // curl/libcurl: CA bundle
  SSL_CERT_FILE: "",                             // OpenSSL: system CA file
  SSL_CERT_DIR: "",                              // OpenSSL: system CA dir
};

// TLS vars passed through to child processes via the environment (no CLI flag).
const TLS_ENV_VARS = ["CURL_CA_BUNDLE", "SSL_CERT_FILE", "SSL_CERT_DIR"];

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

/** Pick the repos URL: explicit flag > R_REPOS_URL > R_REGISTRY_URL. */
export function resolveIndexUrl(explicit, cfg = null) {
  cfg = cfg || resolveEnv();
  return explicit || cfg.R_REPOS_URL || cfg.R_REGISTRY_URL || null;
}

/**
 * Translate resolved config into Rscript/remotes option flags.
 *
 * R has no monolithic CLI flag surface like pip; we accumulate the knobs we
 * honour (timeout, retries, verbosity) as a small list that `testInstallations`
 * and `getAvailableVersions` weave into the R expression / request.
 */
export function rOptions(cfg) {
  const opts = [];
  let level = parseInt(cfg.R_VERBOSE, 10);
  if (Number.isNaN(level)) level = 0;
  if (level > 0) opts.push("--verbose"); // remotes honours options(verbose=TRUE) analog
  opts.push("--timeout", String(cfg.R_DEFAULT_TIMEOUT));
  opts.push("--retries", String(cfg.R_DOWNLOAD_RETRIES));
  return opts;
}

/** Child-process environment with resolved TLS cert vars applied. */
export function subprocessEnv(cfg) {
  const env = { ...process.env };
  for (const name of TLS_ENV_VARS) {
    if (cfg[name]) env[name] = cfg[name];
  }
  // Thread the download timeout through so libcurl-based fetches honour it.
  env.R_DEFAULT_INTERNET_TIMEOUT = String(cfg.R_DEFAULT_TIMEOUT);
  return env;
}

/**
 * Return the list of versions a registry advertises for `package`.
 *
 * Versions are returned newest-first. CRAN has no native "list all versions"
 * CLI, so we query the crandb HTTP JSON API (`<CRAN_DB_URL>/<pkg>/all`) via
 * global `fetch`: the document carries a `versions` object whose keys are
 * the live releases, plus an `archived`/`timeline` map covering versions
 * pulled from the active index. We union both and sort newest-first. When
 * `verbose` is set, the request URL and raw output are echoed so a failed or
 * empty discovery can be debugged.
 */
export async function getAvailableVersions(pkg, indexUrl, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  console.log(`Retrieving versions for '${pkg}' from ${indexUrl}...`);
  const dbUrl = cfg.CRAN_DB_URL.replace(/\/+$/, "");
  const url = `${dbUrl}/${pkg}/all`;
  if (verbose) console.log(`  $ GET ${url}`);

  let raw;
  try {
    const resp = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(parseInt(cfg.R_DEFAULT_TIMEOUT, 10) * 1000),
    });
    raw = await resp.text();
  } catch (e) {
    // fetch raises a family of errors; treat all as fatal
    console.error(`Error querying crandb: ${e}`);
    process.exit(1);
  }

  if (verbose) echo(raw);
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    console.error("Could not parse crandb JSON response.");
    return [];
  }

  // Live versions live under `versions` (an object keyed by version string);
  // versions pulled from the active index live under `timeline`/`archived`.
  const seen = new Set();
  let versions = Object.keys(data.versions || {});
  for (const key of ["timeline", "archived"]) {
    const block = data[key];
    if (block && typeof block === "object" && !Array.isArray(block)) {
      versions = versions.concat(Object.keys(block));
    }
  }
  versions = versions.filter((v) => {
    if (seen.has(v)) return false;
    seen.add(v);
    return true;
  });
  if (!versions.length) {
    console.error("Could not find any versions in crandb output.");
    return [];
  }
  return versions.sort(versionCmp).reverse(); // newest-first
}

/** Compare two R versions split into int/str parts (ascending). */
function versionCmp(a, b) {
  const ka = versionKey(a);
  const kb = versionKey(b);
  const n = Math.max(ka.length, kb.length);
  for (let i = 0; i < n; i++) {
    const x = ka[i];
    const y = kb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNum = typeof x === "number";
    const yNum = typeof y === "number";
    if (xNum && yNum) {
      if (x !== y) return x - y;
    } else {
      const xs = String(x);
      const ys = String(y);
      if (xs !== ys) return xs < ys ? -1 : 1;
    }
  }
  return 0;
}

/** Sort key splitting an R version (`1.2-3`/`1.2.3`) into int parts. */
function versionKey(version) {
  return version.split(/[.\-]/).map((p) => (/^\d+$/.test(p) ? parseInt(p, 10) : p));
}

/**
 * Create a fresh isolated R library if needed; return its library path.
 *
 * Each install-test targets a throwaway R library directory (`.Library`)
 * rather than the system library, so probes never mutate the host R install.
 * The library is pinned conceptually to `rVersion` (default
 * `DEFAULT_R_VERSION`) — the R toolchain itself is host-provided, so the pin
 * is recorded/echoed rather than re-bootstrapped. Pass `rVersion=null` to
 * skip the pin announcement. `verbose` echoes the provisioning step so a
 * failed setup can be debugged.
 */
export function setupVenv(envDir, rVersion = DEFAULT_R_VERSION, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  if (!fs.existsSync(envDir)) {
    console.log(`Creating isolated R library at: ${envDir}`);
    fs.mkdirSync(envDir, { recursive: true });
  }

  const libPath = path.resolve(envDir); // remotes installs into this --lib

  if (rVersion) ensureRVersion(libPath, rVersion, cfg, verbose);
  return libPath;
}

/** Record the R version the test library expects (host-provided toolchain). */
function ensureRVersion(libPath, rVersion, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  console.log(`Ensuring R==${rVersion} in the test environment...`);
  const cmd = ["-e", "cat(as.character(getRversion()))"];
  if (verbose) console.log(`  $ Rscript ${cmd.join(" ")}`);
  const res = spawnSync("Rscript", cmd, {
    encoding: "utf8",
    env: subprocessEnv(cfg),
    maxBuffer: 50 * 1024 * 1024, // defensive guard against future verbose output
  });
  if (verbose) echo(res.stdout, res.stderr);
  if (res.status !== 0) {
    // status is null when the child was killed by a signal (e.g. buffer
    // overflow SIGTERM) — stderr is empty then, so fall back to the signal
    // name / spawn error rather than report a blank/misleading message.
    const detail = lastLine(res.stderr)
      || (res.signal && `terminated by signal ${res.signal}`)
      || (res.error && res.error.message)
      || "unknown error";
    console.error(
      `Warning: could not confirm R==${rVersion}: ${detail}`,
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

/** True if R `options` already carry a `--verbose` flag. */
function hasVerbose(options) {
  return options.some((o) => o === "--verbose");
}

/**
 * Run `cmd`, echoing combined output live while capturing it.
 *
 * Resolves to `[returncode, combinedOutput]`. Used in verbose mode so the user
 * watches the install in real time (e.g. a slow source build or a hang) yet
 * the captured text still feeds the JSON report.
 */
function stream(cmd, env) {
  return new Promise((resolve) => {
    const proc = spawn("Rscript", cmd, { env, stdio: ["ignore", "pipe", "pipe"] });
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
 * Each version is installed via
 * `Rscript -e 'remotes::install_version("<pkg>", version="<ver>",
 * repos="<repo>", lib="<tmp>")'` into a throwaway temp library, success
 * classified on returncode. Returns the list of result objects. If `firstOnly`
 * is set, stops after the first version that installs successfully. When
 * `verbose` is set, R's full output is streamed live (and `--verbose` is
 * added if none is present) so install failures can be debugged; the captured
 * output is also folded into the report under `log`/`error`.
 */
export async function testInstallations(libPath, pkg, indexUrl, versions, outputJson, {
  firstOnly = false, cfg = null, verbose = false,
} = {}) {
  cfg = cfg || resolveEnv();
  const env = subprocessEnv(cfg);
  const options = rOptions(cfg);
  const repos = indexUrl || cfg.R_REGISTRY_URL;
  const results = [];
  const installable = [];

  for (let idx = 0; idx < versions.length; idx++) {
    const version = versions[idx];
    const target = `${pkg}==${version}`;
    console.log(`[${idx + 1}/${versions.length}] Attempting to install: ${target}...`);

    // A fresh temp library per version keeps installs hermetic and avoids
    // cross-version contamination of the shared --lib dir.
    const tmpLib = fs.mkdtempSync(path.join(libPath, "cran-itest-"));
    const wantVerbose = verbose && !hasVerbose(options) ? "TRUE" : "FALSE";
    const expr =
      `options(timeout=${cfg.R_DEFAULT_TIMEOUT}); ` +
      `remotes::install_version("${pkg}", version="${version}", ` +
      `repos="${repos}", lib="${tmpLib}", upgrade="never", ` +
      `quiet=${wantVerbose === "TRUE" ? "FALSE" : "TRUE"})`;
    const cmd = ["-e", expr];

    let returncode, stdoutText, stderrText, signal = null, spawnError = null;
    if (verbose) {
      console.log(`  $ Rscript ${cmd.join(" ")}`);
      const [code, output] = await stream(cmd, env);
      returncode = code;
      stdoutText = stderrText = output; // streamed combined; same text both ways
    } else {
      const res = spawnSync("Rscript", cmd, {
        encoding: "utf8",
        env,
        maxBuffer: 50 * 1024 * 1024, // defensive guard against future verbose output
      });
      returncode = res.status;
      stdoutText = res.stdout;
      stderrText = res.stderr;
      signal = res.signal; // set when status is null (child killed by signal)
      spawnError = res.error;
    }

    if (returncode === 0) {
      console.log(`  ✅ SUCCESS: ${target}`);
      results.push({ version, status: "success", log: lastLine(stdoutText) });
      installable.push(version);
    } else {
      console.log(`  ❌ FAILED: ${target}`);
      // A null returncode means the child was killed by a signal (e.g. buffer
      // overflow SIGTERM) — stderr is empty then, so fall back to the signal
      // name / spawn error so the failure isn't recorded blank.
      const error = lastLine(stderrText)
        || (signal && `terminated by signal ${signal}`)
        || (spawnError && spawnError.message)
        || "Unknown error";
      results.push({ version, status: "failed", error });
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

const HELP = `usage: main.mjs [-h] [--repos INDEX_URL] [--lib-dir VENV_DIR]
                [--r-version R_VERSION] [--output OUTPUT] [--limit LIMIT]
                [--first-only] [-v] package

Find installable versions of a package from a CRAN registry.

positional arguments:
  package               Package name to probe (e.g. jsonlite).

options:
  -h, --help            show this help message and exit
  --repos INDEX_URL     Custom CRAN mirror (repos) URL. Defaults to $R_REPOS_URL,
                        then $R_REGISTRY_URL, then https://cloud.r-project.org.
  --lib-dir VENV_DIR    Directory for the isolated test R library.
                        (default: .rlib-test-install)
  --r-version R_VERSION
                        R version to expect in the test library ('none' to skip
                        the check). (default: ${DEFAULT_R_VERSION})
  --output OUTPUT       Path to write the JSON report.
                        (default: installation_report.json)
  --limit LIMIT         Only test the newest N versions (default: all).
  --first-only          Stop after the first version that installs successfully.
  -v, --verbose         Stream full R output for every step so failures are
                        debuggable.
`;

/** Parse a `main`-style argv list into an options object (mirrors argparse). */
export function parseArgs(argv = null) {
  argv = argv === null ? process.argv.slice(2) : argv;
  const args = {
    package: null,
    indexUrl: null,
    venvDir: ".rlib-test-install",
    rVersion: DEFAULT_R_VERSION,
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
    } else if (a === "--repos") {
      args.indexUrl = next();
    } else if (a === "--lib-dir") {
      args.venvDir = next();
    } else if (a === "--r-version") {
      args.rVersion = next();
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

  console.log(`Found ${versions.length} version(s) to test (registry: ${cfg.R_REGISTRY_NAME}).`);
  const rVersion = String(args.rVersion).toLowerCase() === "none" ? null : args.rVersion;
  const libPath = setupVenv(args.venvDir, rVersion, cfg, args.verbose);
  await testInstallations(libPath, args.package, indexUrl, versions, args.output, {
    firstOnly: args.firstOnly, cfg, verbose: args.verbose,
  });
  return 0;
}

// main() accepts an optional argv list. Pass one explicitly to drive the tool
// programmatically (e.g. from another script or a test); omit it and main()
// falls back to parseArgs(null), which reads from process.argv (normal CLI use).
//
// Example — probe the newest 5 versions of jsonlite, stop at the first installable:
//     main(["jsonlite", "--repos", "https://cloud.r-project.org",
//           "--limit", "5", "--first-only"])
//
// Equivalent on the command line:
//     node main.mjs jsonlite \
//         --repos https://cloud.r-project.org --limit 5 --first-only

import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then((code) => process.exit(code)); // argv=null -> parseArgs reads process.argv
}
