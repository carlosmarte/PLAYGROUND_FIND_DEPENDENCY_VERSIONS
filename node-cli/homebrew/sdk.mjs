#!/usr/bin/env node
/**
 * Programmatic SDK over `main.mjs` — the single funnel for every caller.
 *
 *     cli.mjs   ->  HomebrewVersionsSDK  ->  main.mjs
 *     external  ->  HomebrewVersionsSDK  ->  main.mjs
 *
 * Both the interactive REPL and any external script drive the tool through this
 * SDK instead of calling `main` directly. The SDK owns session configuration,
 * lazily provisions the isolated download cache, returns *structured* results
 * (`Report`), and is built to be:
 *
 *   * **extended** — subclass `HomebrewVersionsSDK` and override the
 *     `beforeProbe` / `afterProbe` hooks (or any method) to inject behaviour; and
 *   * **driven by args** — `fromArgv` builds an SDK from a `main`-style argv
 *     list, and `run` passes raw CLI args straight through to `main.main`.
 *
 * External one-liners:
 *
 *     import * as sdk from "./sdk.mjs";
 *     const report = await sdk.test("wget", { source: "https://formulae.brew.sh", limit: 5 });
 *     console.log(report.installable);        // ['1.21.4', ...]
 *
 *     const versions = await sdk.versions("wget"); // just list what the registry advertises
 *     const report = await sdk.find("wget");       // stop at the first token that fetches
 *
 * Structured output (call from any consuming script — no console scraping):
 *
 *     const report = await sdk.test("wget");
 *     report.toDict();                    // JSON-able object (summary + per-version)
 *     report.toJson();                    // -> string
 *     report.writeJson("report.json");    // -> writes the file, returns the path
 *
 *     sdk.versionsOutput("wget");         // { package, indexUrl, count, versions }
 *
 * Object form (hold one per session, mutate `.config` freely):
 *
 *     const s = new sdk.HomebrewVersionsSDK({ source: "https://formulae.brew.sh", brewVersion: "4.3.0" });
 *     s.config.package = "wget";
 *     await s.test({ limit: 10 });
 *
 * Extension example:
 *
 *     class QuietSDK extends sdk.HomebrewVersionsSDK {
 *       beforeProbe(pkg, versions) { return versions.slice(0, 3); }   // never test more than 3
 *       afterProbe(report) {
 *         report.results = report.results.filter((r) => r.status === "success");
 *         return report;
 *       }
 *     }
 *
 * Raw passthrough (external -> SDK -> main, argv untouched):
 *
 *     await new sdk.HomebrewVersionsSDK().run(["wget", "--limit", "5", "--first-only"]);
 */

import fs from "node:fs";

import * as main from "./main.mjs";

// Re-export the engine's constants so callers depend only on the SDK surface.
export const DEFAULT_BREW_VERSION = main.DEFAULT_BREW_VERSION;
export const ENV_DEFAULTS = main.ENV_DEFAULTS;

// Sentinel for "argument not supplied" — distinct from an explicit `null`,
// which is itself meaningful (indexUrl=null => use brew's default, no
// --source; limit=null => test every version).
export const UNSET = Symbol("UNSET");

export class HomebrewVersionsError extends Error {
  constructor(message) {
    super(message);
    this.name = "HomebrewVersionsError";
  }
}

/**
 * Everything the SDK needs to drive a probe; every field has a default.
 *
 * `indexUrl` carries a third state beyond string/null: the `UNSET` sentinel
 * means "resolve from the environment" (the default), matching `main`'s
 * `$HOMEBREW_SOURCE > $BREW_REGISTRY_URL > formulae.brew.sh` chain. An explicit
 * `null` means "use brew's own default" (omit `--source` entirely).
 */
export class Config {
  constructor({
    package: pkg = null,
    indexUrl = UNSET,
    venvDir = ".venv-test-install",
    output = "installation_report.json",
    brewVersion = DEFAULT_BREW_VERSION, // null/"none" => skip toolchain check
    limit = null,
    verbose = false, // stream full brew output so fetches are debuggable
    env = {}, // per-call overrides for ENV_DEFAULTS
  } = {}) {
    this.package = pkg;
    this.indexUrl = indexUrl;
    this.venvDir = venvDir;
    this.output = output;
    this.brewVersion = brewVersion;
    this.limit = limit;
    this.verbose = verbose;
    this.env = env;
  }
}

/** Structured outcome of a fetch-test run (wraps `main`'s raw objects). */
export class Report {
  constructor({ package: pkg, indexUrl, outputPath, results = [] }) {
    this.package = pkg;
    this.indexUrl = indexUrl;
    this.outputPath = outputPath;
    this.results = results;
  }

  /** Tokens that fetched cleanly, newest-first. */
  get installable() {
    return this.results.filter((r) => r.status === "success").map((r) => r.version);
  }

  /** Tokens that failed to fetch. */
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

export class HomebrewVersionsSDK {
  constructor(config = null) {
    if (config instanceof Config) {
      this.config = config;
    } else {
      const overrides = { ...(config || {}) };
      // Accept `source=` as a friendly alias for the `indexUrl` field.
      if ("source" in overrides) {
        overrides.indexUrl = overrides.source;
        delete overrides.source;
      }
      this.config = new Config(overrides);
    }
    this._venvDir = null; // lazily provisioned download-cache dir
  }

  // -- construction from CLI args ---------------------------------------

  /**
   * Build an SDK from a `main`-style argv list (e.g. `process.argv.slice(2)`).
   *
   * Mirrors the CLI exactly: an absent `--source` resolves from the
   * environment (`UNSET`), and `--brew-version none` skips the toolchain check.
   */
  static fromArgv(argv) {
    const ns = main.parseArgs(argv);
    const brewVersion = String(ns.brewVersion).toLowerCase() === "none" ? null : ns.brewVersion;
    return new HomebrewVersionsSDK(new Config({
      package: ns.formula,
      indexUrl: ns.source === null ? UNSET : ns.source,
      venvDir: ns.venvDir,
      output: ns.output,
      brewVersion,
      limit: ns.limit,
      verbose: ns.verbose,
    }));
  }

  // -- config resolution -------------------------------------------------

  /** Resolved env cfg (ENV_DEFAULTS < process.env < `config.env`). */
  resolveEnv() {
    return main.resolveEnv(Object.keys(this.config.env || {}).length ? this.config.env : null);
  }

  /** The source URL brew will actually receive (`null` => its default). */
  effectiveIndexUrl() {
    if (this.config.indexUrl === UNSET) {
      return main.resolveIndexUrl(null, this.resolveEnv());
    }
    return this.config.indexUrl;
  }

  // -- venv lifecycle ----------------------------------------------------

  /**
   * Drop the cached download dir so the next op re-provisions it.
   *
   * Call after changing `config.venvDir` or `config.brewVersion`.
   */
  invalidateVenv() {
    this._venvDir = null;
  }

  /** Provision the download cache once and return its directory. */
  ensurePip() {
    if (this._venvDir === null) {
      let bv = this.config.brewVersion;
      bv = bv === null || String(bv).toLowerCase() === "none" ? null : bv;
      this._venvDir = main.setupVenv(this.config.venvDir, bv, this.resolveEnv(), this.config.verbose);
    }
    return this._venvDir;
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

  /** Fetch-test until the first token that works; return a `Report`. */
  find(pkg = null) {
    return this._probe(pkg, UNSET, true);
  }

  /**
   * Fetch-test versions (newest-first), write the JSON report, return it.
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
      throw new HomebrewVersionsError("no formula set; pass one or set config.package");
    }
    if (pkg) this.config.package = pkg; // an inline formula becomes the default
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
      throw new HomebrewVersionsError(`no versions found for '${name}'`);
    }

    const venvDir = this.ensurePip();
    const results = await main.testInstallations(
      venvDir, name, indexUrl, versions, this.config.output,
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
  return new HomebrewVersionsSDK({ package: pkg, ...config }).availableVersions();
}

/** One-shot: JSON-able envelope of the versions a registry advertises. */
export function versionsOutput(pkg, config = {}) {
  return new HomebrewVersionsSDK({ package: pkg, ...config }).versionsOutput();
}

/** One-shot: fetch-test until the first token that works. */
export function find(pkg, config = {}) {
  return new HomebrewVersionsSDK({ package: pkg, ...config }).find();
}

/** One-shot: fetch-test versions and write a report. */
export function test(pkg, config = {}) {
  return new HomebrewVersionsSDK({ package: pkg, ...config }).test();
}

/** One-shot raw passthrough to `main.main`. */
export function run(argv) {
  return new HomebrewVersionsSDK().run(argv);
}
