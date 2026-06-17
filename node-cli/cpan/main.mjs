#!/usr/bin/env node
/**
 * Find installable versions of a package from a (custom) CPAN registry.
 *
 * Discovers every version CPAN advertises for a distribution via the MetaCPAN
 * HTTP JSON API (`/v1/release/_search?q=distribution:<Dist>&fields=version`),
 * then attempts to install each one into an isolated `--local-lib` prefix with
 * `cpanm`, recording success/failure per version to a JSON report.
 *
 * Example:
 *     node main.mjs JSON \
 *         --index-url https://www.cpan.org
 *
 *     # only probe the newest 5 versions, stop at the first that installs
 *     node main.mjs JSON --index-url https://www.cpan.org \
 *         --limit 5 --first-only
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// cpanm tool version the test environment expects by default. Install-tests run
// against this cpanm, so it governs resolver/fetch behaviour. Override via
// --cpanm-version (CLI) or the `cpanm` command (REPL). cpanm is not pinnable the
// way pip is, so this is advisory: we surface it and warn on a mismatch.
export const DEFAULT_CPANM_VERSION = "1.7047";

// Environment knobs read via process.env, each falling back to the value the
// Perl / cpanm / TLS ecosystem uses by default ("industry standard"). cpanm
// auto-reads PERL_CPANM_* vars from the environment; we resolve them explicitly
// so the documented default still applies when the var is unset, and so they can
// be surfaced (REPL `env`) and threaded into every cpanm invocation we build.
export const ENV_DEFAULTS = {
  PERL_CPANM_VERBOSE: "0",                       // cpanm: quiet (0 = no --verbose)
  PERL_CPANM_CERT: "",                           // cpanm: use system CA store
  CPAN_META_URL: "https://fastapi.metacpan.org/v1",  // MetaCPAN JSON API base
  PERL_CPANM_MIRROR: "https://www.cpan.org",     // cpanm: --mirror base
  PERL_CPANM_INSECURE: "0",                       // cpanm: keep TLS verification
  PERL_CPANM_TIMEOUT: "15",                      // cpanm: 15s socket timeout
  PERL_CPANM_RETRIES: "5",                       // advisory: fetch retries
  CPAN_REGISTRY_URL: "https://www.cpan.org",     // our index-url fallback
  CPAN_REGISTRY_NAME: "CPAN",                    // registry display name
  REQUESTS_CA_BUNDLE: "",                        // urllib: certifi CA bundle
  SSL_CERT_FILE: "",                             // OpenSSL: system CA file
  SSL_CERT_DIR: "",                              // OpenSSL: system CA dir
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

/** Pick the index URL: explicit flag > CPAN_REGISTRY_URL > PERL_CPANM_MIRROR. */
export function resolveIndexUrl(explicit, cfg = null) {
  cfg = cfg || resolveEnv();
  return explicit || cfg.CPAN_REGISTRY_URL || cfg.PERL_CPANM_MIRROR || null;
}

/** Translate resolved config into cpanm command-line flags. */
export function cpanmOptions(cfg) {
  const opts = [];
  let level = parseInt(cfg.PERL_CPANM_VERBOSE, 10);
  if (Number.isNaN(level)) level = 0;
  if (level > 0) opts.push("--verbose"); // cpanm: chatty build output
  if (cfg.PERL_CPANM_INSECURE && cfg.PERL_CPANM_INSECURE !== "0") {
    opts.push("--insecure");
  }
  opts.push("--timeout", String(cfg.PERL_CPANM_TIMEOUT));
  return opts;
}

/** Child-process environment with resolved cpanm/TLS vars applied. */
export function subprocessEnv(cfg) {
  const env = { ...process.env };
  for (const name of TLS_ENV_VARS) {
    if (cfg[name]) env[name] = cfg[name];
  }
  if (cfg.PERL_CPANM_CERT) env.PERL_CPANM_CERT = cfg.PERL_CPANM_CERT;
  return env;
}

/**
 * Derive the MetaCPAN JSON API base.
 *
 * The index URL the user passes is the CPAN mirror (`https://www.cpan.org`)
 * used for *installs*; version *discovery* always goes through MetaCPAN's
 * JSON API (`$CPAN_META_URL`), which the mirror does not serve.
 */
function metaBase(indexUrl, cfg) {
  return cfg.CPAN_META_URL.replace(/\/+$/, "");
}

/**
 * Return the list of versions CPAN advertises for `package`.
 *
 * `package` may be a module (`JSON::PP`) or a distribution (`JSON`); we
 * query MetaCPAN's release search by distribution, whose results we sort
 * newest-first. When `verbose` is set, the URL and raw output are echoed so
 * a failed or empty discovery can be debugged.
 */
export async function getAvailableVersions(pkg, indexUrl, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  console.log(`Retrieving versions for '${pkg}' from ${indexUrl}...`);
  const base = metaBase(indexUrl, cfg);
  // A module name (Foo::Bar) maps to a distribution (Foo-Bar) on MetaCPAN.
  const dist = pkg.replace(/::/g, "-");
  const query = new URLSearchParams({
    q: `distribution:${dist}`,
    fields: "version,date",
    size: "100",
    sort: "date:desc",
  });
  const url = `${base}/release/_search?${query.toString()}`;
  if (verbose) console.log(`  $ GET ${url}`);

  let payload;
  try {
    const resp = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(parseInt(cfg.PERL_CPANM_TIMEOUT, 10) * 1000),
    });
    payload = await resp.text();
  } catch (e) {
    console.error(`Error querying MetaCPAN: ${e}`);
    return [];
  }

  if (verbose) echo(payload);
  let versions;
  try {
    const data = JSON.parse(payload);
    const hits = (data.hits && data.hits.hits) || [];
    // Sorted newest-first by date via the query; dedupe preserving order.
    versions = [];
    const seen = new Set();
    for (const h of hits) {
      const v = String((h.fields && h.fields.version) || "").trim();
      if (v && !seen.has(v)) {
        seen.add(v);
        versions.push(v);
      }
    }
  } catch (e) {
    console.error(`Could not parse MetaCPAN JSON: ${e}`);
    return [];
  }
  if (!versions.length) {
    console.error("No releases found on MetaCPAN.");
  }
  return versions;
}

/**
 * Create a fresh local-lib prefix if needed; return its path.
 *
 * Perl has no per-project virtualenv: the isolated sandbox is a throwaway
 * `--local-lib` directory each `cpanm` installs into. The directory is
 * created lazily and reused. `cpanmVersion` is advisory (cpanm is not
 * pinnable like pip); pass `cpanmVersion=null` to skip the version check.
 * `verbose` echoes the version probe so a mismatch can be debugged.
 */
export function setupVenv(envDir, cpanmVersion = DEFAULT_CPANM_VERSION, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  if (!fs.existsSync(envDir)) {
    console.log(`Creating local-lib sandbox at: ${envDir}`);
    fs.mkdirSync(envDir, { recursive: true });
  }

  if (cpanmVersion) ensureCpanmVersion(cpanmVersion, cfg, verbose);
  // The "handle" the test step needs is just the local-lib directory.
  return envDir;
}

/** Check the installed cpanm against `cpanmVersion` (advisory only). */
function ensureCpanmVersion(cpanmVersion, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  console.log(`Ensuring cpanm==${cpanmVersion} in the test environment...`);
  const cmd = ["--version"];
  if (verbose) console.log(`  $ cpanm ${cmd.join(" ")}`);
  const res = spawnSync("cpanm", cmd, { encoding: "utf8", env: subprocessEnv(cfg) });
  if (verbose) echo(res.stdout, res.stderr);
  if (res.status !== 0) {
    console.error(
      `Warning: could not verify cpanm==${cpanmVersion}: ${lastLine(res.stderr) || "cpanm not found"}`,
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

/** True if cpanm `options` already carry a `--verbose` flag. */
function hasVerbose(options) {
  return options.some((o) => o.startsWith("--verbose"));
}

/**
 * Run `cpanm <cmd>`, echoing combined output live while capturing it.
 *
 * Resolves to `[returncode, combinedOutput]`. Used in verbose mode so the user
 * watches cpanm in real time (e.g. a slow build or a hang) yet the captured
 * text still feeds the JSON report.
 */
function stream(cmd, env) {
  return new Promise((resolve) => {
    const proc = spawn("cpanm", cmd, { env, stdio: ["ignore", "pipe", "pipe"] });
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
 * Returns the list of result objects. If `firstOnly` is set, stops after the
 * first version that installs successfully. When `verbose` is set, cpanm's
 * full output is streamed live (and a `--verbose` flag is added if none is
 * present) so install failures can be debugged; the captured output is also
 * folded into the report under `log`/`error`.
 */
export async function testInstallations(envDir, pkg, indexUrl, versions, outputJson, {
  firstOnly = false, cfg = null, verbose = false,
} = {}) {
  cfg = cfg || resolveEnv();
  const env = subprocessEnv(cfg);
  const options = cpanmOptions(cfg);
  const results = [];
  const installable = [];

  for (let idx = 0; idx < versions.length; idx++) {
    const version = versions[idx];
    const target = `${pkg}@${version}`;
    console.log(`[${idx + 1}/${versions.length}] Attempting to install: ${target}...`);

    // Each version installs into its own local-lib subdir so versions never
    // clobber one another and the sandbox stays inspectable on failure.
    const localLib = path.join(envDir, `${pkg.replace(/::/g, "-")}-${version}`);
    const cmd = ["--local-lib", localLib, "--notest", target, ...options];
    if (indexUrl) cmd.push("--mirror", indexUrl, "--mirror-only");
    // Bump cpanm's own verbosity if the user wants detail and nothing set it.
    if (verbose && !hasVerbose(options)) cmd.push("--verbose");

    let returncode, stdoutText, stderrText;
    if (verbose) {
      console.log(`  $ cpanm ${cmd.join(" ")}`);
      const [code, output] = await stream(cmd, env);
      returncode = code;
      stdoutText = stderrText = output; // streamed combined; same text both ways
    } else {
      const res = spawnSync("cpanm", cmd, { encoding: "utf8", env });
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
                [--cpanm-version CPANM_VERSION] [--output OUTPUT] [--limit LIMIT]
                [--first-only] [-v] package

Find installable versions of a package from a CPAN registry.

positional arguments:
  package               Module or distribution to probe (e.g. JSON).

options:
  -h, --help            show this help message and exit
  --index-url INDEX_URL
                        Custom CPAN mirror URL. Defaults to $CPAN_REGISTRY_URL,
                        then $PERL_CPANM_MIRROR, then https://www.cpan.org.
  --venv-dir VENV_DIR   Directory for the isolated local-lib sandbox.
                        (default: .cpan-test-lib)
  --cpanm-version CPANM_VERSION
                        cpanm version expected in the test sandbox ('none' to
                        skip the check). (default: ${DEFAULT_CPANM_VERSION})
  --output OUTPUT       Path to write the JSON report.
                        (default: installation_report.json)
  --limit LIMIT         Only test the newest N versions (default: all).
  --first-only          Stop after the first version that installs successfully.
  -v, --verbose         Stream full cpanm output for every step so failures are
                        debuggable.
`;

/** Parse a `main`-style argv list into an options object (mirrors argparse). */
export function parseArgs(argv = null) {
  argv = argv === null ? process.argv.slice(2) : argv;
  const args = {
    package: null,
    indexUrl: null,
    venvDir: ".cpan-test-lib",
    cpanmVersion: DEFAULT_CPANM_VERSION,
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
    } else if (a === "--cpanm-version") {
      args.cpanmVersion = next();
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

  console.log(`Found ${versions.length} version(s) to test (registry: ${cfg.CPAN_REGISTRY_NAME}).`);
  const cpanmVersion = String(args.cpanmVersion).toLowerCase() === "none" ? null : args.cpanmVersion;
  const envDir = setupVenv(args.venvDir, cpanmVersion, cfg, args.verbose);
  await testInstallations(envDir, args.package, indexUrl, versions, args.output, {
    firstOnly: args.firstOnly, cfg, verbose: args.verbose,
  });
  return 0;
}

// main() accepts an optional argv list. Pass one explicitly to drive the tool
// programmatically (e.g. from another script or a test); omit it and main()
// falls back to parseArgs(null), which reads from process.argv (normal CLI use).
//
// Example — probe the newest 5 versions of JSON, stop at the first installable:
//     main(["JSON", "--index-url", "https://www.cpan.org",
//           "--limit", "5", "--first-only"])
//
// Equivalent on the command line:
//     node main.mjs JSON \
//         --index-url https://www.cpan.org --limit 5 --first-only

import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then((code) => process.exit(code)); // argv=null -> parseArgs reads process.argv
}
