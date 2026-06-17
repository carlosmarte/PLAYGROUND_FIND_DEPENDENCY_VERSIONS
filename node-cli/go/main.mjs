#!/usr/bin/env node
/**
 * Find installable versions of a module from a (custom) Go module proxy.
 *
 * Discovers every version a proxy advertises for a module via
 * `go list -m -versions`, then attempts to fetch each one into an isolated
 * throwaway module, recording success/failure per version to a JSON report.
 *
 * Example:
 *     node main.mjs github.com/stretchr/testify \
 *         --proxy https://my-proxy.example.com
 *
 *     # only probe the newest 5 versions, stop at the first that fetches
 *     node main.mjs github.com/stretchr/testify --proxy https://proxy \
 *         --limit 5 --first-only
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// go version the test environment is pinned to by default. Fetch-tests run
// against this toolchain, so it governs resolver/cooldown behaviour. Override via
// --go-version (CLI) or the `go` command (REPL). The go toolchain is whatever is
// on PATH; this is informational (Go selects the active toolchain).
export const DEFAULT_GO_VERSION = "1.23.4";

// Environment knobs read via process.env, each falling back to the value the
// Go / module / TLS ecosystem uses by default ("industry standard"). go itself
// auto-reads GO* vars from the environment; we resolve them explicitly so the
// documented default still applies when the var is unset, and so they can be
// surfaced (REPL `env`) and threaded into every go invocation we build.
export const ENV_DEFAULTS = {
  GO_VERBOSE: "0",                               // go: quiet (0 = no -x)
  GOPROXY: "https://proxy.golang.org",           // go: module proxy
  GOSUMDB: "sum.golang.org",                     // go: checksum database
  GOFLAGS: "",                                    // go: extra flags injected
  GONOSUMCHECK: "",                               // go: skip checksum (legacy)
  GOINSECURE: "",                                 // go: hosts allowed over HTTP
  GOPRIVATE: "",                                  // go: private module globs
  GO_REGISTRY_URL: "https://proxy.golang.org",   // our proxy fallback
  GO_REGISTRY_NAME: "proxy.golang.org",          // registry display name
  SSL_CERT_FILE: "",                             // OpenSSL: system CA file
  SSL_CERT_DIR: "",                              // OpenSSL: system CA dir
};

// TLS vars passed through to child processes via the environment (no CLI flag).
const TLS_ENV_VARS = ["SSL_CERT_FILE", "SSL_CERT_DIR"];

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

/** Pick the proxy URL: explicit flag > GOPROXY > GO_REGISTRY_URL. */
export function resolveIndexUrl(explicit, cfg = null) {
  cfg = cfg || resolveEnv();
  return explicit || cfg.GOPROXY || cfg.GO_REGISTRY_URL || null;
}

/** Translate resolved config into go command-line flags. */
export function goOptions(cfg) {
  const opts = [];
  let level;
  const parsed = parseInt(cfg.GO_VERBOSE, 10);
  level = Number.isNaN(parsed) ? 0 : parsed;
  if (level > 0) opts.push("-x"); // go -x: print the commands it runs
  if (cfg.GOFLAGS) opts.push(...cfg.GOFLAGS.split(/\s+/).filter(Boolean));
  return opts;
}

/** Child-process environment with resolved proxy/TLS cfg applied. */
export function subprocessEnv(cfg) {
  const env = { ...process.env };
  for (const name of TLS_ENV_VARS) {
    if (cfg[name]) env[name] = cfg[name];
  }
  // Thread Go's module knobs through so every go child obeys them.
  env.GOPROXY = cfg.GOPROXY;
  env.GOSUMDB = cfg.GOSUMDB;
  for (const name of ["GOFLAGS", "GOINSECURE", "GOPRIVATE", "GONOSUMCHECK"]) {
    if (cfg[name]) env[name] = cfg[name];
  }
  return env;
}

/**
 * Return the list of versions a proxy advertises for `package`.
 *
 * Versions are returned newest-first. `go list -m -versions` prints them
 * space-separated oldest-first, so we reverse to match `pip`'s newest-first
 * contract. When `verbose` is set, the go command and its raw output are
 * echoed so a failed or empty discovery can be debugged.
 */
export function getAvailableVersions(pkg, indexUrl, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  console.log(`Retrieving versions for '${pkg}' from ${indexUrl}...`);
  const cmd = ["list", "-m", "-versions", pkg];
  cmd.push(...goOptions(cfg));
  const env = subprocessEnv(cfg);
  if (indexUrl) env.GOPROXY = indexUrl; // -versions reads the proxy from GOPROXY
  if (verbose) console.log(`  $ GOPROXY=${env.GOPROXY} go ${cmd.join(" ")}`);

  const res = spawnSync("go", cmd, { encoding: "utf8", env });
  if (res.status !== 0) {
    if (verbose) echo(res.stdout, res.stderr);
    console.error(`Error running 'go list -m -versions': ${(res.stderr || "").trim()}`);
    process.exit(1);
  }

  if (verbose) echo(res.stdout);
  // Output: "<module> v1.0.0 v1.1.0 v1.2.0" (module name first, then versions
  // oldest-first). Drop the module token, then reverse for newest-first.
  const tokens = (res.stdout || "").split(/\s+/).filter(Boolean);
  if (!tokens.length) {
    console.error("Could not find any versions in 'go list' output.");
    return [];
  }
  const versions = tokens.slice(1).filter((t) => t.startsWith("v"));
  if (!versions.length) {
    console.error("Could not find any versions in 'go list' output.");
    return [];
  }
  return versions.reverse(); // go lists oldest-first; we want newest-first
}

/**
 * Create a fresh throwaway module if needed; return its directory path.
 *
 * The sandbox is a temp module (`go mod init tmp`) into which each candidate
 * version is fetched. The active toolchain is reported as `goVersion`
 * (default `DEFAULT_GO_VERSION`) so fetch-tests run against a known go. Pass
 * `goVersion=null` to keep whatever go is on PATH. `verbose` echoes the init
 * output so a failed scaffold can be debugged.
 */
export function setupVenv(envDir, goVersion = DEFAULT_GO_VERSION, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  if (!fs.existsSync(path.join(envDir, "go.mod"))) {
    console.log(`Creating throwaway module at: ${envDir}`);
    fs.mkdirSync(envDir, { recursive: true });
    const init = spawnSync("go", ["mod", "init", "tmp"], {
      encoding: "utf8", env: subprocessEnv(cfg), cwd: envDir,
    });
    if (verbose) echo(init.stdout, init.stderr);
    if (init.status !== 0) {
      console.error(
        `Warning: could not init throwaway module: ${lastLine(init.stderr) || "unknown error"}`,
      );
    }
  }

  if (goVersion) ensurePipVersion(envDir, goVersion, cfg, verbose);
  return envDir;
}

/** Report the active go toolchain (PATH, not the module dir, owns it). */
function ensurePipVersion(envDir, goVersion, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  console.log(`Ensuring go==${goVersion} in the test environment...`);
  const cmd = ["version"];
  if (verbose) console.log(`  $ go ${cmd.join(" ")}`);
  const res = spawnSync("go", cmd, { encoding: "utf8", env: subprocessEnv(cfg) });
  if (verbose) echo(res.stdout, res.stderr);
  if (res.status !== 0) {
    console.error(
      `Warning: could not confirm go==${goVersion}: ${lastLine(res.stderr) || "unknown error"}`,
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

/** True if go `options` already carry a `-x`/`-v` flag. */
function hasVerbose(options) {
  return options.some((o) => o === "-x" || o === "-v");
}

/**
 * Run `go <cmd>`, echoing combined output live while capturing it.
 *
 * Resolves to `[returncode, combinedOutput]`. Used in verbose mode so the user
 * watches go in real time (e.g. a slow build or a hang) yet the captured text
 * still feeds the JSON report.
 */
function stream(cmd, env, cwd = undefined) {
  return new Promise((resolve) => {
    const proc = spawn("go", cmd, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
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
 * `pipPath` is the throwaway module directory from `setupVenv`. Returns
 * the list of result objects. If `firstOnly` is set, stops after the first
 * version that fetches successfully. When `verbose` is set, go's full output
 * is streamed live (and a `-x` flag is added if none is present) so fetch
 * failures can be debugged; the captured output is also folded into the report
 * under `log`/`error`.
 */
export async function testInstallations(pipPath, pkg, indexUrl, versions, outputJson, {
  firstOnly = false, cfg = null, verbose = false,
} = {}) {
  cfg = cfg || resolveEnv();
  const env = subprocessEnv(cfg);
  if (indexUrl) env.GOPROXY = indexUrl;
  const options = goOptions(cfg);
  const results = [];
  const installable = [];

  for (let idx = 0; idx < versions.length; idx++) {
    const version = versions[idx];
    const target = `${pkg}@${version}`;
    console.log(`[${idx + 1}/${versions.length}] Attempting to fetch: ${target}...`);

    const cmd = ["get", target];
    cmd.push(...options);
    // Bump go's verbosity if the user wants detail and nothing already set it.
    if (verbose && !hasVerbose(options)) cmd.push("-x");

    let returncode, stdoutText, stderrText;
    if (verbose) {
      console.log(`  $ (cd ${pipPath} && GOPROXY=${env.GOPROXY} go ${cmd.join(" ")})`);
      const [code, output] = await stream(cmd, env, pipPath);
      returncode = code;
      stdoutText = stderrText = output; // streamed combined; same text both ways
    } else {
      const res = spawnSync("go", cmd, { encoding: "utf8", env, cwd: pipPath });
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

const HELP = `usage: main.mjs [-h] [--proxy INDEX_URL] [--venv-dir VENV_DIR]
                [--go-version GO_VERSION] [--output OUTPUT] [--limit LIMIT]
                [--first-only] [-v] package

Find installable versions of a module from a Go module proxy.

positional arguments:
  package               Module path to probe (e.g. github.com/stretchr/testify).

options:
  -h, --help            show this help message and exit
  --proxy INDEX_URL     Custom Go module proxy URL. Defaults to $GOPROXY, then
                        $GO_REGISTRY_URL, then https://proxy.golang.org.
  --venv-dir VENV_DIR   Directory for the isolated throwaway test module.
                        (default: .venv-test-install)
  --go-version GO_VERSION
                        go version to assert in the test module ('none' to keep
                        the active toolchain). (default: ${DEFAULT_GO_VERSION})
  --output OUTPUT       Path to write the JSON report.
                        (default: installation_report.json)
  --limit LIMIT         Only test the newest N versions (default: all).
  --first-only          Stop after the first version that fetches successfully.
  -v, --verbose         Stream full go output for every step so failures are
                        debuggable.
`;

/** Parse a `main`-style argv list into an options object (mirrors argparse). */
export function parseArgs(argv = null) {
  argv = argv === null ? process.argv.slice(2) : argv;
  const args = {
    package: null,
    indexUrl: null,
    venvDir: ".venv-test-install",
    goVersion: DEFAULT_GO_VERSION,
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
    } else if (a === "--proxy") {
      args.indexUrl = next();
    } else if (a === "--venv-dir") {
      args.venvDir = next();
    } else if (a === "--go-version") {
      args.goVersion = next();
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

  console.log(`Found ${versions.length} version(s) to test (registry: ${cfg.GO_REGISTRY_NAME}).`);
  const goVersion = String(args.goVersion).toLowerCase() === "none" ? null : args.goVersion;
  const pipPath = setupVenv(args.venvDir, goVersion, cfg, args.verbose);
  await testInstallations(pipPath, args.package, indexUrl, versions, args.output, {
    firstOnly: args.firstOnly, cfg, verbose: args.verbose,
  });
  return 0;
}

// main() accepts an optional argv list. Pass one explicitly to drive the tool
// programmatically (e.g. from another script or a test); omit it and main()
// falls back to parseArgs(null), which reads from process.argv (normal CLI use).
//
// Example — probe the newest 5 versions of testify, stop at the first installable:
//     main(["github.com/stretchr/testify", "--proxy", "https://proxy.example.com",
//           "--limit", "5", "--first-only"])
//
// Equivalent on the command line:
//     node main.mjs github.com/stretchr/testify \
//         --proxy https://proxy.example.com --limit 5 --first-only

import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then((code) => process.exit(code)); // argv=null -> parseArgs reads process.argv
}
