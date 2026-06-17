#!/usr/bin/env node
/**
 * Programmatic SDK over `main.mjs` — the single funnel for every caller.
 *
 *     cli.mjs   ->  JsrVersionsSDK  ->  main.mjs
 *     external  ->  JsrVersionsSDK  ->  main.mjs
 *
 * Both the interactive REPL and any external script drive the tool through this
 * SDK instead of calling `main` directly. The SDK owns session configuration,
 * lazily provisions the isolated test temp project, returns *structured*
 * results (`Report`), and is built to be:
 *
 *   * **extended** — subclass `JsrVersionsSDK` and override the `beforeProbe`
 *     / `afterProbe` hooks (or any method) to inject behaviour; and
 *   * **driven by args** — `fromArgv` builds an SDK from a `main`-style argv
 *     list, and `run` passes raw CLI args straight through to `main.main`.
 *
 * External one-liners:
 *
 *     import * as sdk from "./sdk.mjs";
 *     const report = await sdk.test("@std/encoding", { indexUrl: "https://jsr.io", limit: 5 });
 *     console.log(report.installable);        // ['1.0.5', ...]
 *
 *     const versions = await sdk.versions("@std/encoding"); // list what the registry advertises
 *     const report = await sdk.find("@std/encoding");       // stop at the first version that installs
 *
 * Structured output (call from any consuming script — no console scraping):
 *
 *     const report = await sdk.test("@std/encoding");
 *     report.toDict();                    // JSON-able object (summary + per-version)
 *     report.toJson();                    // -> string
 *     report.writeJson("report.json");    // -> writes the file, returns the path
 *
 *     sdk.versionsOutput("@std/encoding"); // { package, indexUrl, count, versions }
 *
 * Object form (hold one per session, mutate `.config` freely):
 *
 *     const s = new sdk.JsrVersionsSDK({ indexUrl: "https://jsr.io", jsrVersion: "none" });
 *     s.config.package = "@std/encoding";
 *     await s.test({ limit: 10 });
 *
 * Extension example:
 *
 *     class QuietSDK extends sdk.JsrVersionsSDK {
 *       beforeProbe(pkg, versions) { return versions.slice(0, 3); }   // never test more than 3
 *       afterProbe(report) {
 *         report.results = report.results.filter((r) => r.status === "success");
 *         return report;
 *       }
 *     }
 *
 * Raw passthrough (external -> SDK -> main, argv untouched):
 *
 *     await new sdk.JsrVersionsSDK().run(["@std/encoding", "--limit", "5", "--first-only"]);
 */

import fs from "node:fs";

import * as main from "./main.mjs";

// Re-export the engine's constants so callers depend only on the SDK surface.
export const DEFAULT_JSR_VERSION = main.DEFAULT_JSR_VERSION;
export const ENV_DEFAULTS = main.ENV_DEFAULTS;

// Sentinel for "argument not supplied" — distinct from an explicit `null`,
// which is itself meaningful (indexUrl=null => use jsr's default, no
// --registry; limit=null => test every version).
export const UNSET = Symbol("UNSET");

export class JsrVersionsError extends Error {
  constructor(message) {
    super(message);
    this.name = "JsrVersionsError";
  }
}

/**
 * Everything the SDK needs to drive a probe; every field has a default.
 *
 * `indexUrl` carries a third state beyond string/null: the `UNSET` sentinel
 * means "resolve from the environment" (the default), matching `main`'s
 * `$JSR_URL > $JSR_REGISTRY_URL > jsr.io` chain. An explicit `null` means
 * "use jsr's own default" (omit `--registry` entirely).
 */
export class Config {
  constructor({
    package: pkg = null,
    indexUrl = UNSET,
    venvDir = ".jsr-test-install",
    output = "installation_report.json",
    jsrVersion = DEFAULT_JSR_VERSION, // null/"none" => keep jsr on PATH
    limit = null,
    verbose = false, // stream full npx jsr output so installs are debuggable
    env = {}, // per-call overrides for ENV_DEFAULTS
  } = {}) {
    this.package = pkg;
    this.indexUrl = indexUrl;
    this.venvDir = venvDir;
    this.output = output;
    this.jsrVersion = jsrVersion;
    this.limit = limit;
    this.verbose = verbose;
    this.env = env;
  }
}

/** Structured outcome of an install-test run (wraps `main`'s raw objects). */
export class Report {
  constructor({ package: pkg, indexUrl, outputPath, results = [] }) {
    this.package = pkg;
    this.indexUrl = indexUrl;
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
      indexUrl: this.indexUrl,
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

export class JsrVersionsSDK {
  constructor(config = null) {
    // Accept either a Config instance or a plain object of overrides.
    this.config = config instanceof Config ? config : new Config(config || {});
    this._pipPath = null; // lazily provisioned test temp-project dir
  }

  // -- construction from CLI args ---------------------------------------

  /**
   * Build an SDK from a `main`-style argv list (e.g. `process.argv.slice(2)`).
   *
   * Mirrors the CLI exactly: an absent `--registry` resolves from the
   * environment (`UNSET`), and `--jsr-version none` keeps the jsr on PATH.
   */
  static fromArgv(argv) {
    const ns = main.parseArgs(argv);
    const jsrVersion = String(ns.jsrVersion).toLowerCase() === "none" ? null : ns.jsrVersion;
    return new JsrVersionsSDK(new Config({
      package: ns.package,
      indexUrl: ns.indexUrl === null ? UNSET : ns.indexUrl,
      venvDir: ns.venvDir,
      output: ns.output,
      jsrVersion,
      limit: ns.limit,
      verbose: ns.verbose,
    }));
  }

  // -- config resolution -------------------------------------------------

  /** Resolved env cfg (ENV_DEFAULTS < process.env < `config.env`). */
  resolveEnv() {
    return main.resolveEnv(Object.keys(this.config.env || {}).length ? this.config.env : null);
  }

  /** The registry URL jsr will actually receive (`null` => jsr default). */
  effectiveIndexUrl() {
    if (this.config.indexUrl === UNSET) {
      return main.resolveIndexUrl(null, this.resolveEnv());
    }
    return this.config.indexUrl;
  }

  // -- venv lifecycle ----------------------------------------------------

  /**
   * Drop the cached temp project so the next op re-provisions it.
   *
   * Call after changing `config.venvDir` or `config.jsrVersion`.
   */
  invalidateVenv() {
    this._pipPath = null;
  }

  /** Provision the test temp project once and return its directory path. */
  ensurePip() {
    if (this._pipPath === null) {
      let jv = this.config.jsrVersion;
      jv = jv === null || String(jv).toLowerCase() === "none" ? null : jv;
      this._pipPath = main.setupVenv(this.config.venvDir, jv, this.resolveEnv(), this.config.verbose);
    }
    return this._pipPath;
  }

  // -- core operations ---------------------------------------------------

  /** List versions the registry advertises (newest-first), capped by limit. */
  async availableVersions(pkg = null, limit = UNSET) {
    const name = this._requirePackage(pkg);
    const versions = await main.getAvailableVersions(
      name, this.effectiveIndexUrl(), this.resolveEnv(), this.config.verbose,
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
      indexUrl: this.effectiveIndexUrl(),
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
      throw new JsrVersionsError("no package set; pass one or set config.package");
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
    const indexUrl = this.effectiveIndexUrl();
    const cfg = this.resolveEnv();

    let versions = await main.getAvailableVersions(name, indexUrl, cfg, this.config.verbose);
    versions = this._applyLimit(versions, limit);
    versions = this.beforeProbe(name, versions);
    if (!versions.length) {
      throw new JsrVersionsError(`no versions found for '${name}'`);
    }

    const pipPath = this.ensurePip();
    const results = await main.testInstallations(
      pipPath, name, indexUrl, versions, this.config.output,
      { firstOnly, cfg, verbose: this.config.verbose },
    );
    const report = new Report({
      package: name, indexUrl, outputPath: this.config.output, results,
    });
    return this.afterProbe(report);
  }
}

// -- module-level convenience funnels (external -> SDK -> main) -----------

/** One-shot: list versions a registry advertises for `pkg`. */
export function versions(pkg, config = {}) {
  return new JsrVersionsSDK({ package: pkg, ...config }).availableVersions();
}

/** One-shot: JSON-able envelope of the versions a registry advertises. */
export function versionsOutput(pkg, config = {}) {
  return new JsrVersionsSDK({ package: pkg, ...config }).versionsOutput();
}

/** One-shot: install-test until the first version that works. */
export function find(pkg, config = {}) {
  return new JsrVersionsSDK({ package: pkg, ...config }).find();
}

/** One-shot: install-test versions and write a report. */
export function test(pkg, config = {}) {
  return new JsrVersionsSDK({ package: pkg, ...config }).test();
}

/** One-shot raw passthrough to `main.main`. */
export function run(argv) {
  return new JsrVersionsSDK().run(argv);
}
