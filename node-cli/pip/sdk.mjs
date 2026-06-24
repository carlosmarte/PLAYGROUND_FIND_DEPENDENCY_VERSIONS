#!/usr/bin/env node
/**
 * Programmatic SDK over `main.mjs` — the single funnel for every caller.
 *
 *     cli.mjs   ->  PipVersionsSDK  ->  main.mjs
 *     external  ->  PipVersionsSDK  ->  main.mjs
 *
 * Both the interactive REPL and any external script drive the tool through this
 * SDK instead of calling `main` directly. The SDK owns session configuration,
 * lazily provisions the isolated test virtualenv, returns *structured* results
 * (`Report`), and is built to be:
 *
 *   * **extended** — subclass `PipVersionsSDK` and override the `beforeProbe`
 *     / `afterProbe` hooks (or any method) to inject behaviour; and
 *   * **driven by args** — `fromArgv` builds an SDK from a `main`-style argv
 *     list, and `run` passes raw CLI args straight through to `main.main`.
 *
 * External one-liners:
 *
 *     import * as sdk from "./sdk.mjs";
 *     const report = await sdk.test("numpy", { indexUrl: "https://reg/simple", limit: 5 });
 *     console.log(report.installable);        // ['1.26.4', ...]
 *
 *     const versions = sdk.versions("numpy"); // just list what the registry advertises
 *     const report = await sdk.find("numpy"); // stop at the first version that installs
 *
 * Structured output (call from any consuming script — no console scraping):
 *
 *     const report = await sdk.test("numpy");
 *     report.toDict();                    // JSON-able object (summary + per-version)
 *     report.toJson();                    // -> string
 *     report.writeJson("report.json");    // -> writes the file, returns the path
 *
 *     sdk.versionsOutput("numpy");     // { package, indexUrl, count, versions }
 *
 * Object form (hold one per session, mutate `.config` freely):
 *
 *     const s = new sdk.PipVersionsSDK({ indexUrl: "https://reg/simple", pipVersion: "26.1.1" });
 *     s.config.package = "numpy";
 *     await s.test({ limit: 10 });
 *
 * Extension example:
 *
 *     class QuietSDK extends sdk.PipVersionsSDK {
 *       beforeProbe(pkg, versions) { return versions.slice(0, 3); }   // never test more than 3
 *       afterProbe(report) {
 *         report.results = report.results.filter((r) => r.status === "success");
 *         return report;
 *       }
 *     }
 *
 * Raw passthrough (external -> SDK -> main, argv untouched):
 *
 *     await new sdk.PipVersionsSDK().run(["numpy", "--limit", "5", "--first-only"]);
 */

import fs from "node:fs";

import * as main from "./main.mjs";

// Re-export the engine's constants so callers depend only on the SDK surface.
export const DEFAULT_PIP_VERSION = main.DEFAULT_PIP_VERSION;
export const ENV_DEFAULTS = main.ENV_DEFAULTS;

// Sentinel for "argument not supplied" — distinct from an explicit `null`,
// which is itself meaningful (indexUrl=null => use pip's default, no
// --index-url; limit=null => test every version).
export const UNSET = Symbol("UNSET");

export class PipVersionsError extends Error {
  constructor(message) {
    super(message);
    this.name = "PipVersionsError";
  }
}

/**
 * Everything the SDK needs to drive a probe; every field has a default.
 *
 * `indexUrl` carries a third state beyond string/null: the `UNSET` sentinel
 * means "resolve from the environment" (the default), matching `main`'s
 * `$PIP_INDEX_URL > $PYTHON_REGISTRY_URL > pypi.org` chain. An explicit `null`
 * means "use pip's own default" (omit `--index-url` entirely).
 */
export class Config {
  constructor({
    package: pkg = null,
    indexUrl = UNSET,
    venvDir = ".venv-test-install",
    output = "installation_report.json",
    pipVersion = DEFAULT_PIP_VERSION, // null/"none" => keep bootstrapped pip
    limit = null,
    verbose = false, // stream full pip output so installs are debuggable
    env = {}, // per-call overrides for ENV_DEFAULTS
  } = {}) {
    this.package = pkg;
    this.indexUrl = indexUrl;
    this.venvDir = venvDir;
    this.output = output;
    this.pipVersion = pipVersion;
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

export class PipVersionsSDK {
  constructor(config = null) {
    // Accept either a Config instance or a plain object of overrides.
    this.config = config instanceof Config ? config : new Config(config || {});
    this._pipPath = null; // lazily provisioned test-venv pip
  }

  // -- construction from CLI args ---------------------------------------

  /**
   * Build an SDK from a `main`-style argv list (e.g. `process.argv.slice(2)`).
   *
   * Mirrors the CLI exactly: an absent `--index-url` resolves from the
   * environment (`UNSET`), and `--pip-version none` keeps the venv's
   * bootstrapped pip.
   */
  static fromArgv(argv) {
    const ns = main.parseArgs(argv);
    const pipVersion = String(ns.pipVersion).toLowerCase() === "none" ? null : ns.pipVersion;
    return new PipVersionsSDK(new Config({
      package: ns.package,
      indexUrl: ns.indexUrl === null ? UNSET : ns.indexUrl,
      venvDir: ns.venvDir,
      output: ns.output,
      pipVersion,
      limit: ns.limit,
      verbose: ns.verbose,
    }));
  }

  // -- config resolution -------------------------------------------------

  /** Resolved env cfg (ENV_DEFAULTS < process.env < `config.env`). */
  resolveEnv() {
    return main.resolveEnv(Object.keys(this.config.env || {}).length ? this.config.env : null);
  }

  /** The index URL pip will actually receive (`null` => pip default). */
  effectiveIndexUrl() {
    if (this.config.indexUrl === UNSET) {
      return main.resolveIndexUrl(null, this.resolveEnv());
    }
    return this.config.indexUrl;
  }

  // -- venv lifecycle ----------------------------------------------------

  /**
   * Drop the cached venv pip so the next op re-provisions it.
   *
   * Call after changing `config.venvDir` or `config.pipVersion`.
   */
  invalidateVenv() {
    this._pipPath = null;
  }

  /** Provision the test venv once and return its pip path. */
  ensurePip() {
    if (this._pipPath === null) {
      let pv = this.config.pipVersion;
      pv = pv === null || String(pv).toLowerCase() === "none" ? null : pv;
      this._pipPath = main.setupVenv(this.config.venvDir, pv, this.resolveEnv(), this.config.verbose, this.effectiveIndexUrl());
    }
    return this._pipPath;
  }

  // -- core operations ---------------------------------------------------

  /** List versions the registry advertises (newest-first), capped by limit. */
  availableVersions(pkg = null, limit = UNSET) {
    const name = this._requirePackage(pkg);
    const versions = main.getAvailableVersions(
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
  versionsOutput(pkg = null, limit = UNSET) {
    const found = this.availableVersions(pkg, limit);
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
      throw new PipVersionsError("no package set; pass one or set config.package");
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

    let versions = main.getAvailableVersions(name, indexUrl, cfg, this.config.verbose);
    versions = this._applyLimit(versions, limit);
    versions = this.beforeProbe(name, versions);
    if (!versions.length) {
      throw new PipVersionsError(`no versions found for '${name}'`);
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
  return new PipVersionsSDK({ package: pkg, ...config }).availableVersions();
}

/** One-shot: JSON-able envelope of the versions a registry advertises. */
export function versionsOutput(pkg, config = {}) {
  return new PipVersionsSDK({ package: pkg, ...config }).versionsOutput();
}

/** One-shot: install-test until the first version that works. */
export function find(pkg, config = {}) {
  return new PipVersionsSDK({ package: pkg, ...config }).find();
}

/** One-shot: install-test versions and write a report. */
export function test(pkg, config = {}) {
  return new PipVersionsSDK({ package: pkg, ...config }).test();
}

/** One-shot raw passthrough to `main.main`. */
export function run(argv) {
  return new PipVersionsSDK().run(argv);
}
