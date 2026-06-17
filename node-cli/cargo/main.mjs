#!/usr/bin/env node
/**
 * Find installable versions of a crate from a (custom) Cargo registry.
 *
 * Discovers every version a registry advertises for a crate via the crates.io
 * JSON API (`https://crates.io/api/v1/crates/<crate>`), then attempts to fetch
 * each one into an isolated throwaway crate, recording success/failure per version
 * to a JSON report.
 *
 * Example:
 *     node main.mjs serde \
 *         --registry https://my-registry.example.com
 *
 *     # only probe the newest 5 versions, stop at the first that fetches
 *     node main.mjs serde --registry https://reg \
 *         --limit 5 --first-only
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// cargo/rust version the test environment is pinned to by default. Fetch-tests
// run against this toolchain, so it governs resolver/cooldown behaviour. Override
// via --cargo-version (CLI) or the `cargo` command (REPL). Cargo ships with the
// Rust toolchain, so this is informational (rustup selects the active toolchain).
export const DEFAULT_CARGO_VERSION = "1.83.0";

// Environment knobs read via process.env, each falling back to the value the
// Rust / Cargo / TLS ecosystem uses by default ("industry standard"). cargo
// itself auto-reads CARGO_* vars from the environment; we resolve them explicitly
// so the documented default still applies when the var is unset, and so they can
// be surfaced (REPL `env`) and threaded into every cargo invocation we build.
export const ENV_DEFAULTS = {
  CARGO_TERM_VERBOSE: "false",                   // cargo: quiet (no --verbose)
  CARGO_NET_RETRY: "3",                           // cargo: 3 network retries
  CARGO_HTTP_TIMEOUT: "30",                       // cargo: 30s HTTP timeout
  CARGO_HTTP_CAINFO: "",                          // cargo: use system CA store
  CARGO_REGISTRIES_CRATES_IO_PROTOCOL: "sparse",  // cargo: sparse index protocol
  CARGO_API_URL: "https://crates.io/api/v1/crates",  // our version-list API base
  RUST_REGISTRY_URL: "https://crates.io",         // our registry fallback
  RUST_REGISTRY_NAME: "crates.io",                // registry display name
  SSL_CERT_FILE: "",                              // OpenSSL: system CA file
  SSL_CERT_DIR: "",                               // OpenSSL: system CA dir
  HTTPS_PROXY: "",                                // libcurl/cargo: HTTPS proxy
};

// TLS/proxy vars passed through to child processes via the environment (no CLI flag).
const TLS_ENV_VARS = ["SSL_CERT_FILE", "SSL_CERT_DIR", "HTTPS_PROXY"];

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

/** Pick the registry URL: explicit flag > CARGO_REGISTRIES_CRATES_IO > RUST_REGISTRY_URL. */
export function resolveIndexUrl(explicit, cfg = null) {
  cfg = cfg || resolveEnv();
  return (
    explicit
    || process.env.CARGO_REGISTRIES_CRATES_IO_INDEX
    || cfg.RUST_REGISTRY_URL
    || null
  );
}

/** Translate resolved config into cargo command-line flags. */
export function cargoOptions(cfg) {
  const opts = [];
  if (["1", "true", "yes"].includes(String(cfg.CARGO_TERM_VERBOSE).toLowerCase())) {
    opts.push("--verbose"); // cargo --verbose
  }
  // cargo reads net retry/timeout from the environment (threaded via
  // subprocessEnv), so there are no direct CLI equivalents to add here.
  return opts;
}

/** Child-process environment with resolved TLS/network cfg applied. */
export function subprocessEnv(cfg) {
  const env = { ...process.env };
  for (const name of TLS_ENV_VARS) {
    if (cfg[name]) env[name] = cfg[name];
  }
  // Thread cargo's network knobs through so every cargo child obeys them.
  env.CARGO_NET_RETRY = String(cfg.CARGO_NET_RETRY);
  env.CARGO_HTTP_TIMEOUT = String(cfg.CARGO_HTTP_TIMEOUT);
  if (cfg.CARGO_HTTP_CAINFO) env.CARGO_HTTP_CAINFO = cfg.CARGO_HTTP_CAINFO;
  return env;
}

/**
 * Return the list of versions a registry advertises for `pkg`.
 *
 * Versions are returned newest-first, mirroring the order the crates.io API
 * serves them (`versions[].num`, already newest-first). When `verbose` is set,
 * the API URL and its raw output are echoed so a failed or empty discovery can
 * be debugged. crates.io has no robust "list versions" subcommand, so we go
 * straight to its JSON API over `fetch`.
 */
export async function getAvailableVersions(pkg, indexUrl, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  console.log(`Retrieving versions for '${pkg}' from ${indexUrl}...`);
  const apiBase = cfg.CARGO_API_URL.replace(/\/+$/, "");
  const url = `${apiBase}/${pkg}`;
  if (verbose) console.log(`  $ GET ${url}`);

  let raw;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      parseInt(cfg.CARGO_HTTP_TIMEOUT, 10) * 1000,
    );
    try {
      const resp = await fetch(url, {
        headers: { "User-Agent": "cargo-versions/1.0" },
        signal: controller.signal,
      });
      raw = await resp.text();
    } finally {
      clearTimeout(timeout);
    }
  } catch (e) { // fetch network error, abort/timeout, ...
    if (verbose) echo(String(e));
    console.error(`Error querying crates.io API: ${e}`);
    process.exit(1);
  }

  if (verbose) echo(raw);
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    console.error("Could not parse JSON from the crates.io API.");
    return [];
  }
  const versions = (data.versions || [])
    .map((v) => v.num)
    .filter((num) => num);
  if (!versions.length) {
    console.error("Could not find any 'versions[].num' in the API response.");
    return [];
  }
  return versions; // crates.io already serves these newest-first
}

/**
 * Create a fresh throwaway crate if needed; return its directory path.
 *
 * The sandbox is a temp crate (`cargo init`) into which each candidate version
 * is added and fetched. The active toolchain is reported as `cargoVersion`
 * (default `DEFAULT_CARGO_VERSION`) so fetch-tests run against a known cargo.
 * Pass `cargoVersion=null` to keep whatever toolchain rustup selects. `verbose`
 * echoes the init output so a failed scaffold can be debugged.
 */
export function setupVenv(envDir, cargoVersion = DEFAULT_CARGO_VERSION, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  if (!fs.existsSync(path.join(envDir, "Cargo.toml"))) {
    console.log(`Creating throwaway crate at: ${envDir}`);
    fs.mkdirSync(envDir, { recursive: true });
    const init = spawnSync(
      "cargo", ["init", "--name", "verprobe", "--vcs", "none", envDir],
      { encoding: "utf8", env: subprocessEnv(cfg) },
    );
    if (verbose) echo(init.stdout, init.stderr);
    if (init.status !== 0) {
      console.error(
        `Warning: could not init throwaway crate: `
        + `${lastLine(init.stderr) || "unknown error"}`,
      );
    }
  }

  if (cargoVersion) ensureCargoVersion(envDir, cargoVersion, cfg, verbose);
  return envDir;
}

/** Report the active cargo toolchain (rustup, not the crate dir, owns it). */
function ensureCargoVersion(envDir, cargoVersion, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  console.log(`Ensuring cargo==${cargoVersion} in the test environment...`);
  const cmd = ["--version"];
  if (verbose) console.log(`  $ cargo ${cmd.join(" ")}`);
  const res = spawnSync("cargo", cmd, { encoding: "utf8", env: subprocessEnv(cfg) });
  if (verbose) echo(res.stdout, res.stderr);
  if (res.status !== 0) {
    console.error(
      `Warning: could not confirm cargo==${cargoVersion}: `
      + `${lastLine(res.stderr) || "unknown error"}`,
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

/** True if cargo `options` already carry a `--verbose` flag. */
function hasVerbose(options) {
  return options.some((o) => o.startsWith("--verbose") || o === "-v");
}

/** Derive a cargo --registry alias from a registry URL (host-ish slug). */
function registryName(indexUrl) {
  let slug = (indexUrl || "").replace(/^https?:\/\//, "").replace(/^\/+|\/+$/g, "");
  slug = slug.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "custom";
}

/**
 * Run `cmd`, echoing combined output live while capturing it.
 *
 * Resolves to `[returncode, combinedOutput]`. Used in verbose mode so the user
 * watches cargo in real time (e.g. a slow build or a hang) yet the captured
 * text still feeds the JSON report.
 */
function stream(cmd, env, cwd = null) {
  return new Promise((resolve) => {
    const proc = spawn("cargo", cmd, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
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
 * Attempt to fetch each version; write an incremental JSON report.
 *
 * `pipPath` is the throwaway crate directory from `setupVenv`. Returns the list
 * of result objects. If `firstOnly` is set, stops after the first version that
 * fetches successfully. When `verbose` is set, cargo's full output is streamed
 * live (and a `--verbose` flag is added if none is present) so fetch failures
 * can be debugged; the captured output is also folded into the report under
 * `log`/`error`.
 */
export async function testInstallations(pipPath, pkg, indexUrl, versions, outputJson, {
  firstOnly = false, cfg = null, verbose = false,
} = {}) {
  cfg = cfg || resolveEnv();
  const env = subprocessEnv(cfg);
  const options = cargoOptions(cfg);
  const results = [];
  const installable = [];

  for (let idx = 0; idx < versions.length; idx++) {
    const version = versions[idx];
    const target = `${pkg}@${version}`;
    console.log(`[${idx + 1}/${versions.length}] Attempting to fetch: ${target}...`);

    // `cargo add` pins the dependency, `cargo fetch` downloads it — together
    // they prove the registry actually serves this version. Re-add each time
    // (cargo overwrites the prior pin in Cargo.toml).
    let addCmd = ["add", target, ...options];
    if (indexUrl && !indexUrl.includes("crates.io")) {
      addCmd = [...addCmd, "--registry", registryName(indexUrl)];
    }
    let fetchCmd = ["fetch", ...options];
    // Bump cargo's verbosity if the user wants detail and nothing already set it.
    if (verbose && !hasVerbose(options)) {
      addCmd.push("--verbose");
      fetchCmd.push("--verbose");
    }

    let returncode, stdoutText, stderrText;
    if (verbose) {
      console.log(`  $ (cd ${pipPath} && cargo ${addCmd.join(" ")} && cargo ${fetchCmd.join(" ")})`);
      let [code, output] = await stream(addCmd, env, pipPath);
      if (code === 0) {
        const [rc2, out2] = await stream(fetchCmd, env, pipPath);
        code = rc2;
        output = output + out2;
      }
      returncode = code;
      stdoutText = stderrText = output; // streamed combined; same text both ways
    } else {
      let res = spawnSync("cargo", addCmd, { encoding: "utf8", env, cwd: pipPath });
      if (res.status === 0) {
        res = spawnSync("cargo", fetchCmd, { encoding: "utf8", env, cwd: pipPath });
      }
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
      results.push({
        version,
        status: "failed",
        error: lastLine(stderrText) || "Unknown error",
      });
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
                [--cargo-version CARGO_VERSION] [--output OUTPUT] [--limit LIMIT]
                [--first-only] [-v] package

Find installable versions of a crate from a Cargo registry.

positional arguments:
  package               Crate name to probe (e.g. serde).

options:
  -h, --help            show this help message and exit
  --registry INDEX_URL  Custom Cargo registry URL. Defaults to
                        $CARGO_REGISTRIES_CRATES_IO_INDEX, then $RUST_REGISTRY_URL,
                        then https://crates.io.
  --venv-dir VENV_DIR   Directory for the isolated throwaway test crate.
                        (default: .venv-test-install)
  --cargo-version CARGO_VERSION
                        cargo version to assert in the test crate ('none' to keep
                        the active toolchain). (default: ${DEFAULT_CARGO_VERSION})
  --output OUTPUT       Path to write the JSON report.
                        (default: installation_report.json)
  --limit LIMIT         Only test the newest N versions (default: all).
  --first-only          Stop after the first version that fetches successfully.
  -v, --verbose         Stream full cargo output for every step so failures are
                        debuggable.
`;

/** Parse a `main`-style argv list into an options object (mirrors argparse). */
export function parseArgs(argv = null) {
  argv = argv === null ? process.argv.slice(2) : argv;
  const args = {
    package: null,
    indexUrl: null,
    venvDir: ".venv-test-install",
    cargoVersion: DEFAULT_CARGO_VERSION,
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
    } else if (a === "--cargo-version") {
      args.cargoVersion = next();
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

  console.log(`Found ${versions.length} version(s) to test (registry: ${cfg.RUST_REGISTRY_NAME}).`);
  const cargoVersion = String(args.cargoVersion).toLowerCase() === "none" ? null : args.cargoVersion;
  const pipPath = setupVenv(args.venvDir, cargoVersion, cfg, args.verbose);
  await testInstallations(pipPath, args.package, indexUrl, versions, args.output, {
    firstOnly: args.firstOnly, cfg, verbose: args.verbose,
  });
  return 0;
}

// main() accepts an optional argv list. Pass one explicitly to drive the tool
// programmatically (e.g. from another script or a test); omit it and main()
// falls back to parseArgs(null), which reads from process.argv (normal CLI use).
//
// Example — probe the newest 5 versions of serde, stop at the first installable:
//     main(["serde", "--registry", "https://reg.example.com",
//           "--limit", "5", "--first-only"])
//
// Equivalent on the command line:
//     node main.mjs serde \
//         --registry https://reg.example.com --limit 5 --first-only

import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then((code) => process.exit(code)); // argv=null -> parseArgs reads process.argv
}
