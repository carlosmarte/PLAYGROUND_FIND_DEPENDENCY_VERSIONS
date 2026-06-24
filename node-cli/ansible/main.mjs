#!/usr/bin/env node
/**
 * Find installable versions of a collection from a (custom) Ansible Galaxy.
 *
 * Discovers every version the Galaxy server advertises for a collection via the
 * Galaxy v3 REST API (`.../collections/index/<ns>/<name>/versions/`), then
 * attempts to install each one into an isolated scratch directory, recording
 * success/failure per version to a JSON report.
 *
 * Example:
 *     node main.mjs community.general \
 *         --galaxy-server https://my-galaxy.example.com
 *
 *     # only probe the newest 5 versions, stop at the first that installs
 *     node main.mjs community.general --galaxy-server https://galaxy.example.com \
 *         --limit 5 --first-only
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// ansible version the test environment is pinned to by default. Install-tests run
// against this ansible-galaxy, so it governs resolver/dependency behaviour.
// Override via --ansible-version (CLI) or the `ansible` command (REPL).
export const DEFAULT_ANSIBLE_VERSION = "11.1.0";

// Environment knobs read via process.env, each falling back to the value the
// Ansible Galaxy / TLS ecosystem uses by default ("industry standard").
// ansible-galaxy itself auto-reads some of these from the environment; we resolve
// them explicitly so the documented default still applies when the var is unset,
// and so they can be surfaced (REPL `env`) and threaded into every ansible-galaxy
// invocation we build.
export const ENV_DEFAULTS = {
  ANSIBLE_VERBOSITY: "0",                              // ansible: quiet (0 = no -v)
  ANSIBLE_GALAXY_DISABLE_GPG_VERIFY: "1",             // ansible: skip signature verify
  ANSIBLE_GALAXY_SERVER: "https://galaxy.ansible.com",  // ansible: default Galaxy
  ANSIBLE_GALAXY_SERVER_URL: "https://galaxy.ansible.com",  // PEP-ish API base
  ANSIBLE_GALAXY_IGNORE_CERTS: "0",                   // ansible: validate certs
  ANSIBLE_GALAXY_TIMEOUT: "60",                       // ansible: 60s socket timeout
  ANSIBLE_GALAXY_RETRIES: "3",                        // ansible: connection retries
  ANSIBLE_REGISTRY_URL: "https://galaxy.ansible.com",  // our galaxy-server fallback
  ANSIBLE_REGISTRY_NAME: "Ansible Galaxy",            // registry display name
  REQUESTS_CA_BUNDLE: "",                             // requests/urllib3: certifi
  SSL_CERT_FILE: "",                                  // OpenSSL: system CA file
  SSL_CERT_DIR: "",                                   // OpenSSL: system CA dir
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

/** Pick the Galaxy server: explicit flag > ANSIBLE_GALAXY_SERVER > ANSIBLE_REGISTRY_URL. */
export function resolveGalaxyServer(explicit, cfg = null) {
  cfg = cfg || resolveEnv();
  return explicit || cfg.ANSIBLE_GALAXY_SERVER || cfg.ANSIBLE_REGISTRY_URL || null;
}

/** Translate resolved config into ansible-galaxy command-line flags. */
export function galaxyOptions(cfg) {
  const opts = [];
  let level = parseInt(cfg.ANSIBLE_VERBOSITY, 10);
  if (Number.isNaN(level)) level = 0;
  if (level > 0) opts.push("-" + "v".repeat(level)); // -v / -vv / -vvv ...
  if (!["", "0", "false", "False"].includes(cfg.ANSIBLE_GALAXY_IGNORE_CERTS)) {
    opts.push("--ignore-certs");
  }
  const server = resolveGalaxyServer(null, cfg);
  if (server) opts.push("--server", server);
  opts.push("--timeout", String(cfg.ANSIBLE_GALAXY_TIMEOUT));
  return opts;
}

/** Child-process environment with resolved TLS cert vars applied. */
export function subprocessEnv(cfg) {
  const env = { ...process.env };
  for (const name of TLS_ENV_VARS) {
    if (cfg[name]) env[name] = cfg[name];
  }
  const server = resolveGalaxyServer(null, cfg);
  if (server) env.ANSIBLE_GALAXY_SERVER = server;
  return env;
}

/**
 * Return the list of versions Galaxy advertises for `package`.
 *
 * `package` is a `namespace.name` collection identifier. Versions are
 * returned newest-first via the Galaxy v3 REST API
 * (`.../collections/index/<ns>/<name>/versions/`), falling back to
 * `ansible-galaxy collection list` if the HTTP query fails. When `verbose`
 * is set, the URL/command and raw output are echoed so a failed or empty
 * discovery can be debugged.
 */
export async function getAvailableVersions(pkg, galaxyServer, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  console.log(`Retrieving versions for '${pkg}' from ${galaxyServer}...`);
  const dot = pkg.indexOf(".");
  const namespace = dot === -1 ? "" : pkg.slice(0, dot);
  const name = dot === -1 ? "" : pkg.slice(dot + 1);
  if (!namespace || !name) {
    console.error("Collection must be in 'namespace.name' form.");
    return [];
  }

  const base = (galaxyServer || cfg.ANSIBLE_GALAXY_SERVER).replace(/\/+$/, "");
  const url =
    `${base}/api/v3/plugin/ansible/content/published/collections/index/` +
    `${namespace}/${name}/versions/`;
  if (verbose) console.log(`  $ GET ${url}`);

  let payload;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      parseInt(cfg.ANSIBLE_GALAXY_TIMEOUT, 10) * 1000,
    );
    try {
      const resp = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      payload = await resp.text();
    } finally {
      clearTimeout(timeout);
    }
  } catch (e) {
    if (verbose) echo(String(e));
    console.error(`HTTP version query failed (${e}); falling back to ansible-galaxy.`);
    return versionsViaCli(pkg, cfg, verbose);
  }

  if (verbose) echo(payload);
  let data;
  try {
    data = JSON.parse(payload);
  } catch {
    console.error("Could not parse Galaxy JSON response.");
    return [];
  }
  // data[].version, already newest-first from the Galaxy API.
  return (data.data || []).filter((entry) => entry.version).map((entry) => entry.version);
}

/** Fallback discovery via `ansible-galaxy collection list` (installed only). */
function versionsViaCli(pkg, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  // Strip any `-v`/`-vv` from the discovery query: we only parse the JSON
  // version list, but verbose ansible-galaxy floods diagnostics — enough output
  // to overflow spawnSync's default 1MB buffer, which kills the child
  // (status=null) and yields an empty stderr.
  let cmd = ["collection", "list", pkg, "--format", "json"];
  cmd = cmd.concat(stripVerbose(galaxyOptions(cfg)));
  if (verbose) console.log(`  $ ansible-galaxy ${cmd.join(" ")}`);
  const res = spawnSync("ansible-galaxy", cmd, {
    encoding: "utf8",
    env: subprocessEnv(cfg),
    maxBuffer: 50 * 1024 * 1024, // defensive guard against future verbose output
  });
  if (res.error || res.status !== 0) {
    if (verbose) echo(res.stdout || "", res.stderr || "");
    // status is null when the child was killed by a signal (e.g. spawnSync
    // SIGTERM on buffer overflow) — stderr is empty in that case, so fall back
    // to the signal name / spawn error so the failure isn't reported blank.
    const detail = (res.stderr || "").trim()
      || (res.signal && `terminated by signal ${res.signal}`)
      || (res.error && res.error.message)
      || "unknown error";
    console.error(`Error running 'ansible-galaxy collection list': ${detail}`);
    return [];
  }
  if (verbose) echo(res.stdout);
  let data;
  try {
    data = JSON.parse(res.stdout);
  } catch {
    // Plain-text fallback: scan for "namespace.name <version>" rows.
    const out = [];
    const re = /\b(\d+\.\d+\.\d+\S*)/g;
    let m;
    while ((m = re.exec(res.stdout || "")) !== null) out.push(m[1]);
    return out;
  }
  const versions = [];
  for (const p of Object.values(data)) {
    const entry = p[pkg];
    if (entry && entry.version) versions.push(entry.version);
  }
  return versions;
}

/**
 * Create a fresh sandbox collections dir if needed; return its path.
 *
 * For Ansible the "isolated test environment" is a scratch directory passed to
 * `ansible-galaxy collection install -p <dir>`; each install lands under it
 * without touching the host's collection paths. `ansibleVersion` is recorded
 * (and verified, best-effort) so install-tests run against a known
 * ansible-galaxy. Pass `ansibleVersion=null` to keep whatever ansible is on
 * PATH. `verbose` echoes the version check so a mismatch can be debugged.
 */
export function setupVenv(envDir, ansibleVersion = DEFAULT_ANSIBLE_VERSION, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  if (!fs.existsSync(envDir)) {
    console.log(`Creating sandbox collections dir at: ${envDir}`);
    fs.mkdirSync(envDir, { recursive: true });
  }

  const installPath = envDir; // ansible-galaxy installs collections under -p <dir>

  if (ansibleVersion) ensureAnsibleVersion(ansibleVersion, cfg, verbose);
  return installPath;
}

/** Verify the ansible-galaxy on PATH matches `ansibleVersion` (best effort). */
function ensureAnsibleVersion(ansibleVersion, cfg = null, verbose = false) {
  cfg = cfg || resolveEnv();
  console.log(`Ensuring ansible==${ansibleVersion} in the test environment...`);
  const cmd = ["--version"];
  if (verbose) console.log(`  $ ansible-galaxy ${cmd.join(" ")}`);
  const res = spawnSync("ansible-galaxy", cmd, {
    encoding: "utf8",
    env: subprocessEnv(cfg),
    maxBuffer: 50 * 1024 * 1024, // defensive guard against future verbose output
  });
  if (res.error && res.error.code === "ENOENT") {
    console.error("Warning: ansible-galaxy not found on PATH.");
    return;
  }
  if (verbose) echo(res.stdout, res.stderr);
  if (res.status !== 0) {
    console.error(
      `Warning: could not verify ansible==${ansibleVersion}: ` +
        `${lastLine(res.stderr) || "unknown error"}`,
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

/** True if ansible-galaxy `options` already carry a `-v`/`-vv` flag. */
function hasVerbose(options) {
  return options.some((o) => o.startsWith("-v"));
}

/** ansible-galaxy `options` with any `-v`/`-vv`/`-vvv` verbosity flag removed. */
function stripVerbose(options) {
  return options.filter((o) => !/^-v+$/.test(o));
}

/**
 * Run `ansible-galaxy <cmd>`, echoing combined output live while capturing it.
 *
 * Resolves to `{ status, output }`. Used in verbose mode so the user watches
 * ansible-galaxy in real time (e.g. a slow download or a hang) yet the captured
 * text still feeds the JSON report.
 */
function stream(cmd, env) {
  return new Promise((resolve) => {
    const proc = spawn("ansible-galaxy", cmd, { env, stdio: ["ignore", "pipe", "pipe"] });
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
 * Returns the list of result objects. If `firstOnly` is set, stops after
 * the first version that installs successfully. When `verbose` is set,
 * ansible-galaxy's full output is streamed live (and a `-v` flag is added if
 * none is present) so install failures can be debugged; the captured output is
 * also folded into the report under `log`/`error`.
 */
export async function testInstallations(installPath, pkg, galaxyServer, versions, outputJson, {
  firstOnly = false, cfg = null, verbose = false,
} = {}) {
  cfg = cfg || resolveEnv();
  const env = subprocessEnv(cfg);
  const options = galaxyOptions(cfg);
  const results = [];
  const installable = [];

  for (let idx = 0; idx < versions.length; idx++) {
    const version = versions[idx];
    const target = `${pkg}:${version}`;
    console.log(`[${idx + 1}/${versions.length}] Attempting to install: ${target}...`);

    // Install into a throwaway prefix per version so a successful install of
    // one does not satisfy/shadow the next.
    const tmp = fs.mkdtempSync(path.join(installPath, "galaxy-"));
    let returncode, stdoutText, stderrText;
    try {
      let cmd = ["collection", "install", target, "-p", tmp, "--force"];
      cmd = cmd.concat(options);
      // Bump verbosity if the user wants detail and nothing already set it.
      if (verbose && !hasVerbose(options)) cmd.push("-v");

      if (verbose) {
        console.log(`  $ ansible-galaxy ${cmd.join(" ")}`);
        const [code, output] = await stream(cmd, env);
        returncode = code;
        stdoutText = stderrText = output; // streamed combined; same text both ways
      } else {
        const res = spawnSync("ansible-galaxy", cmd, {
          encoding: "utf8",
          env,
          maxBuffer: 50 * 1024 * 1024, // defensive guard against future verbose output
        });
        returncode = res.status;
        stdoutText = res.stdout;
        stderrText = res.stderr;
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
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

const HELP = `usage: main.mjs [-h] [--galaxy-server GALAXY_SERVER] [--venv-dir VENV_DIR]
                [--ansible-version ANSIBLE_VERSION] [--output OUTPUT]
                [--limit LIMIT] [--first-only] [-v] package

Find installable versions of a collection from an Ansible Galaxy.

positional arguments:
  package               Collection to probe in 'namespace.name' form (e.g. community.general).

options:
  -h, --help            show this help message and exit
  --galaxy-server GALAXY_SERVER
                        Custom Galaxy server URL. Defaults to $ANSIBLE_GALAXY_SERVER,
                        then $ANSIBLE_REGISTRY_URL, then https://galaxy.ansible.com.
  --venv-dir VENV_DIR   Directory for the isolated sandbox collections install path.
                        (default: .venv-test-install)
  --ansible-version ANSIBLE_VERSION
                        ansible version to expect in the test env ('none' to use whatever
                        is on PATH). (default: ${DEFAULT_ANSIBLE_VERSION})
  --output OUTPUT       Path to write the JSON report.
                        (default: installation_report.json)
  --limit LIMIT         Only test the newest N versions (default: all).
  --first-only          Stop after the first version that installs successfully.
  -v, --verbose         Stream full ansible-galaxy output for every step so failures are
                        debuggable.
`;

/** Parse a `main`-style argv list into an options object (mirrors argparse). */
export function parseArgs(argv = null) {
  argv = argv === null ? process.argv.slice(2) : argv;
  const args = {
    package: null,
    galaxyServer: null,
    venvDir: ".venv-test-install",
    ansibleVersion: DEFAULT_ANSIBLE_VERSION,
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
    } else if (a === "--galaxy-server") {
      args.galaxyServer = next();
    } else if (a === "--venv-dir") {
      args.venvDir = next();
    } else if (a === "--ansible-version") {
      args.ansibleVersion = next();
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
  const galaxyServer = resolveGalaxyServer(args.galaxyServer, cfg);

  let versions = await getAvailableVersions(args.package, galaxyServer, cfg, args.verbose);
  if (!versions.length) {
    console.log("No versions found. Exiting.");
    return 1;
  }

  if (args.limit !== null && !Number.isNaN(args.limit)) {
    versions = versions.slice(0, args.limit);
  }

  console.log(`Found ${versions.length} version(s) to test (registry: ${cfg.ANSIBLE_REGISTRY_NAME}).`);
  const ansibleVersion = String(args.ansibleVersion).toLowerCase() === "none" ? null : args.ansibleVersion;
  const installPath = setupVenv(args.venvDir, ansibleVersion, cfg, args.verbose);
  await testInstallations(installPath, args.package, galaxyServer, versions, args.output, {
    firstOnly: args.firstOnly, cfg, verbose: args.verbose,
  });
  return 0;
}

// main() accepts an optional argv list. Pass one explicitly to drive the tool
// programmatically (e.g. from another script or a test); omit it and main()
// falls back to parseArgs(null), which reads from process.argv (normal CLI use).
//
// Example — probe the newest 5 versions of community.general, stop at the first installable:
//     main(["community.general", "--galaxy-server", "https://galaxy.example.com",
//           "--limit", "5", "--first-only"])
//
// Equivalent on the command line:
//     node main.mjs community.general \
//         --galaxy-server https://galaxy.example.com --limit 5 --first-only

import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then((code) => process.exit(code)); // argv=null -> parseArgs reads process.argv
}
