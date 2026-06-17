#!/usr/bin/env node
/**
 * Programmatic SDK over `main.mjs` — the single funnel for every caller.
 *
 *     cli.mjs   ->  PuppetVersionsSDK  ->  main.mjs
 *     external  ->  PuppetVersionsSDK  ->  main.mjs
 *
 * Both the interactive REPL and any external script drive the tool through this
 * SDK instead of calling `main` directly. The SDK owns session configuration,
 * lazily provisions the isolated sandbox target dir, returns *structured*
 * results (`Report`), and is built to be:
 *
 *   * **extended** — subclass `PuppetVersionsSDK` and override the `beforeProbe`
 *     / `afterProbe` hooks (or any method) to inject behaviour; and
 *   * **driven by args** — `fromArgv` builds an SDK from a `main`-style argv
 *     list, and `run` passes raw CLI args straight through to `main.main`.
 *
 * External one-liners:
 *
 *     import * as sdk from "./sdk.mjs";
 *     const report = await sdk.test("puppetlabs-stdlib", { forgeServer: "https://forgeapi.puppet.com", limit: 5 });
 *     console.log(report.installable);          // ['9.6.0', ...]
 *
 *     const versions = await sdk.versions("puppetlabs-stdlib"); // just list what the Forge advertises
 *     const report = await sdk.find("puppetlabs-stdlib");       // stop at the first that installs
 *
 * Structured output (call from any consuming script — no console scraping):
 *
 *     const report = await sdk.test("puppetlabs-stdlib");
 *     report.toDict();                    // JSON-able object (summary + per-version)
 *     report.toJson();                    // -> string
 *     report.writeJson("report.json");    // -> writes the file, returns the path
 *
 *     sdk.versionsOutput("puppetlabs-stdlib");     // { package, forgeServer, count, versions }
 *
 * Object form (hold one per session, mutate `.config` freely):
 *
 *     const s = new sdk.PuppetVersionsSDK({ forgeServer: "https://forgeapi.puppet.com", puppetVersion: "8.10.0" });
 *     s.config.package = "puppetlabs-stdlib";
 *     await s.test({ limit: 10 });
 *
 * Extension example:
 *
 *     class QuietSDK extends sdk.PuppetVersionsSDK {
 *       beforeProbe(pkg, versions) { return versions.slice(0, 3); }   // never test more than 3
 *       afterProbe(report) {
 *         report.results = report.results.filter((r) => r.status === "success");
 *         return report;
 *       }
 *     }
 *
 * Raw passthrough (external -> SDK -> main, argv untouched):
 *
 *     await new sdk.PuppetVersionsSDK().run(["puppetlabs-stdlib", "--limit", "5", "--first-only"]);
 */

import fs from "node:fs";

import * as main from "./main.mjs";

// Re-export the engine's constants so callers depend only on the SDK surface.
export const DEFAULT_PUPPET_VERSION = main.DEFAULT_PUPPET_VERSION;
export const ENV_DEFAULTS = main.ENV_DEFAULTS;

// Sentinel for "argument not supplied" — distinct from an explicit `null`,
// which is itself meaningful (forgeServer=null => use puppet's default;
// limit=null => test every version).
export const UNSET = Symbol("UNSET");

export class PuppetVersionsError extends Error {
  constructor(message) {
    super(message);
    this.name = "PuppetVersionsError";
  }
}

/**
 * Everything the SDK needs to drive a probe; every field has a default.
 *
 * `forgeServer` carries a third state beyond string/null: the `UNSET` sentinel
 * means "resolve from the environment" (the default), matching `main`'s
 * `$PUPPET_FORGE_SERVER > $PUPPET_REGISTRY_URL > forgeapi.puppet.com` chain. An
 * explicit `null` means "use puppet's own default" (omit the
 * `--module_repository` override entirely).
 */
export class Config {
  constructor({
    package: pkg = null,
    forgeServer = UNSET,
    venvDir = ".venv-test-install",
    output = "installation_report.json",
    puppetVersion = DEFAULT_PUPPET_VERSION, // null/"none" => whatever is on PATH
    limit = null,
    verbose = false, // stream full puppet output so installs are debuggable
    env = {}, // per-call overrides for ENV_DEFAULTS
  } = {}) {
    this.package = pkg;
    this.forgeServer = forgeServer;
    this.venvDir = venvDir;
    this.output = output;
    this.puppetVersion = puppetVersion;
    this.limit = limit;
    this.verbose = verbose;
    this.env = env;
  }
}

/** Structured outcome of an install-test run (wraps `main`'s raw objects). */
export class Report {
  constructor({ package: pkg, forgeServer, outputPath, results = [] }) {
    this.package = pkg;
    this.forgeServer = forgeServer;
    this.outputPath = outputPath;
    this.results = results;
  }

  /** Versions that installed cleanly, newest-first. */
  get installable() {
    return this.results.filter((r) => r.status === "success").map((r) => r.version);
  }

  /** Versions that failed to install. */
  get failed() {
    return this.results.filter((r) => r.status !== "success").map((r) => r.version);
  }

  get firstInstallable() {
    const inst = this.installable;
    return inst.length ? inst[0] : null;
  }

  // -- output surface (callable from any consuming script) ---------------

  /**
   * JSON-able view of this report — the canonical serialized shape.
   *
   * Includes the derived `installable`/`failed`/`firstInstallable` rollups
   * alongside the raw per-version `results` so a consumer can read a summary
   * without recomputing it.
   */
  toDict() {
    return {
      package: this.package,
      forgeServer: this.forgeServer,
      outputPath: this.outputPath,
      count: this.results.length,
      installable: this.installable,
      failed: this.failed,
      firstInstallable: this.firstInstallable,
      results: this.results,
    };
  }

  /** Serialize this report to a JSON string. */
  toJson(indent = 2) {
    return JSON.stringify(this.toDict(), null, indent);
  }

  /** Write this report as JSON to `path`; return the path. */
  writeJson(path, indent = 2) {
    fs.writeFileSync(path, this.toJson(indent) + "\n");
    return path;
  }

  get length() {
    return this.results.length;
  }

  [Symbol.iterator]() {
    return this.results[Symbol.iterator]();
  }
}

export class PuppetVersionsSDK {
  constructor(config = null) {
    // Accept either a Config instance or a plain object of overrides.
    this.config = config instanceof Config ? config : new Config(config || {});
    this._targetDir = null; // lazily provisioned sandbox target dir
  }

  // -- construction from CLI args ---------------------------------------

  /**
   * Build an SDK from a `main`-style argv list (e.g. `process.argv.slice(2)`).
   *
   * Mirrors the CLI exactly: an absent `--forge-server` resolves from the
   * environment (`UNSET`), and `--puppet-version none` uses whatever puppet is
   * on PATH.
   */
  static fromArgv(argv) {
    const ns = main.parseArgs(argv);
    const puppetVersion = String(ns.puppetVersion).toLowerCase() === "none" ? null : ns.puppetVersion;
    return new PuppetVersionsSDK(new Config({
      package: ns.package,
      forgeServer: ns.forgeServer === null ? UNSET : ns.forgeServer,
      venvDir: ns.venvDir,
      output: ns.output,
      puppetVersion,
      limit: ns.limit,
      verbose: ns.verbose,
    }));
  }

  // -- config resolution -------------------------------------------------

  /** Resolved env cfg (ENV_DEFAULTS < process.env < `config.env`). */
  resolveEnv() {
    return main.resolveEnv(Object.keys(this.config.env || {}).length ? this.config.env : null);
  }

  /** The Forge server puppet will actually receive (`null` => default). */
  effectiveForgeServer() {
    if (this.config.forgeServer === UNSET) {
      return main.resolveForgeServer(null, this.resolveEnv());
    }
    return this.config.forgeServer;
  }

  // -- sandbox lifecycle -------------------------------------------------

  /**
   * Drop the cached sandbox target dir so the next op re-provisions it.
   *
   * Call after changing `config.venvDir` or `config.puppetVersion`.
   */
  invalidateVenv() {
    this._targetDir = null;
  }

  /** Provision the sandbox target dir once and return its path. */
  ensurePip() {
    if (this._targetDir === null) {
      let pv = this.config.puppetVersion;
      pv = pv === null || String(pv).toLowerCase() === "none" ? null : pv;
      this._targetDir = main.setupVenv(this.config.venvDir, pv, this.resolveEnv(), this.config.verbose);
    }
    return this._targetDir;
  }

  // -- core operations ---------------------------------------------------

  /** List versions the Forge advertises (newest-first), capped by limit. */
  async availableVersions(pkg = null, limit = UNSET) {
    const name = this._requirePackage(pkg);
    const versions = await main.getAvailableVersions(
      name, this.effectiveForgeServer(), this.resolveEnv(), this.config.verbose,
    );
    return this._applyLimit(versions, limit);
  }

  /**
   * JSON-able envelope for the advertised version list.
   *
   * The structured counterpart to `availableVersions` (which returns the bare
   * list): wraps it with the package, the effective registry URL, and a count
   * so a consumer — or the REPL's `--output` flag — can serialize a `versions`
   * query straight to JSON.
   */
  async versionsOutput(pkg = null, limit = UNSET) {
    const found = await this.availableVersions(pkg, limit);
    return {
      package: this.config.package,
      forgeServer: this.effectiveForgeServer(),
      count: found.length,
      versions: found,
    };
  }

  /** Install-test until the first version that works; return a `Report`. */
  find(pkg = null) {
    return this._probe(pkg, UNSET, true);
  }

  /**
   * Install-test versions (newest-first), write the JSON report, return it.
   *
   * An explicit `limit` overrides `config.limit` for this call only;
   * `limit=null` tests every advertised version.
   */
  test(pkg = null, { limit = UNSET } = {}) {
    return this._probe(pkg, limit, false);
  }

  /** Pass raw CLI args straight through to `main.main` (returns exit code). */
  run(argv) {
    return main.main(argv);
  }

  // -- extension hooks (override in a subclass) --------------------------

  /** Hook: inspect/filter the version list before testing. Return the list. */
  beforeProbe(pkg, versions) {
    return versions;
  }

  /** Hook: post-process the `Report` before it is returned. */
  afterProbe(report) {
    return report;
  }

  // -- internals ---------------------------------------------------------

  _requirePackage(pkg) {
    const name = pkg || this.config.package;
    if (!name) {
      throw new PuppetVersionsError("no package set; pass one or set config.package");
    }
    if (pkg) this.config.package = pkg; // an inline package becomes the default
    return name;
  }

  _applyLimit(versions, limit) {
    const cap = limit === UNSET ? this.config.limit : limit;
    return cap !== null && cap !== undefined ? versions.slice(0, cap) : versions;
  }

  async _probe(pkg, limit, firstOnly) {
    const name = this._requirePackage(pkg);
    const forgeServer = this.effectiveForgeServer();
    const cfg = this.resolveEnv();

    let versions = await main.getAvailableVersions(name, forgeServer, cfg, this.config.verbose);
    versions = this._applyLimit(versions, limit);
    versions = this.beforeProbe(name, versions);
    if (!versions.length) {
      throw new PuppetVersionsError(`no versions found for '${name}'`);
    }

    const targetDir = this.ensurePip();
    const results = await main.testInstallations(
      targetDir, name, forgeServer, versions, this.config.output,
      { firstOnly, cfg, verbose: this.config.verbose },
    );
    const report = new Report({
      package: name, forgeServer, outputPath: this.config.output, results,
    });
    return this.afterProbe(report);
  }
}

// -- module-level convenience funnels (external -> SDK -> main) -----------

/** One-shot: list versions the Puppet Forge advertises for `pkg`. */
export function versions(pkg, config = {}) {
  return new PuppetVersionsSDK({ package: pkg, ...config }).availableVersions();
}

/** One-shot: JSON-able envelope of the versions a registry advertises. */
export function versionsOutput(pkg, config = {}) {
  return new PuppetVersionsSDK({ package: pkg, ...config }).versionsOutput();
}

/** One-shot: install-test until the first version that works. */
export function find(pkg, config = {}) {
  return new PuppetVersionsSDK({ package: pkg, ...config }).find();
}

/** One-shot: install-test versions and write a report. */
export function test(pkg, config = {}) {
  return new PuppetVersionsSDK({ package: pkg, ...config }).test();
}

/** One-shot raw passthrough to `main.main`. */
export function run(argv) {
  return new PuppetVersionsSDK().run(argv);
}
