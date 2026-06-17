#!/usr/bin/env node
/**
 * Interactive REPL front-end — a thin shell over the SDK.
 *
 *     cli.mjs (this REPL)  ->  HomebrewVersionsSDK  ->  main.mjs
 *
 * The REPL holds no engine logic of its own: it parses line input, maps it onto
 * the SDK's `config`, and calls SDK methods. Anything the REPL can do, an
 * external caller can do by driving the same `HomebrewVersionsSDK` directly.
 *
 * Run it interactively:
 *     node cli.mjs
 *
 * Or run a single command non-interactively (handy as a container entrypoint) by
 * passing it as args — the tokens become one REPL command line, then the process
 * exits:
 *     node cli.mjs versions wget
 *     node cli.mjs run wget --limit 5 --first-only -v
 *
 * Then, at the (homebrew-versions) prompt:
 *     registry https://formulae.brew.sh
 *     versions wget              # list what the registry advertises
 *     find wget                  # fetch-test until the first token that works
 *     test wget                  # fetch-test every token, write a JSON report
 *     test wget 10               # fetch-test only the newest 10 tokens
 *     verbose on                 # stream full brew output to debug fetch failures
 *     help                       # full command list
 *     quit
 */

import readline from "node:readline";
import fs from "node:fs";
import process from "node:process";

import { HomebrewVersionsSDK, HomebrewVersionsError, ENV_DEFAULTS } from "./sdk.mjs";

// Split a command line into tokens (shell-like, honoring quotes). Returns null
// on unbalanced quotes so the caller can leave the line untouched.
function splitTokens(line) {
  const tokens = [];
  let cur = "";
  let quote = null;
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has) tokens.push(cur);
      cur = "";
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (quote) return null; // unbalanced quote
  if (has) tokens.push(cur);
  return tokens;
}

// Quote a token for safe round-tripping (mirrors shlex.quote).
function shlexQuote(tok) {
  if (tok === "") return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(tok)) return tok;
  return "'" + tok.replace(/'/g, "'\\''") + "'";
}

/**
 * Split `line` into `[cleanLine, outputPath]`.
 *
 * Recognises an inline `--output=PATH` or `--output PATH` token anywhere in the
 * line, removes it, and returns the remaining command plus the path. When no
 * such token is present, returns the line unchanged and `null`.
 */
function extractOutput(line) {
  const tokens = splitTokens(line);
  if (tokens === null) return [line, null]; // unbalanced quotes: leave untouched
  const kept = [];
  let outputPath = null;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.startsWith("--output=")) {
      outputPath = token.slice("--output=".length);
    } else if (token === "--output") {
      if (i + 1 < tokens.length) outputPath = tokens[++i];
    } else {
      kept.push(token);
    }
  }
  if (outputPath === null) return [line, null];
  return [kept.map(shlexQuote).join(" "), outputPath];
}

const INTRO =
  "homebrew-versions interactive shell. Type 'help' or '?' for commands, " +
  "'show' for current settings, 'quit' to exit. " +
  "Append --output=PATH to any command to also save its output: data " +
  "commands (versions/find/test) write structured JSON, others write text.";
const PROMPT = "(homebrew-versions) ";

export class HomebrewVersionsREPL {
  constructor(client = null) {
    // All session state lives in the SDK's config — the REPL is a view onto it.
    // Inject a custom/extended SDK via `client` to reuse this shell.
    this.sdk = client || new HomebrewVersionsSDK();
    // Structured payload the last data command produced, for --output JSON.
    // Reset per command in onecmd; null means "no structured result".
    this._lastPayload = null;
  }

  get cfg() {
    return this.sdk.config;
  }

  // -- helpers -----------------------------------------------------------

  // Return the formula from `arg`, falling back to the session formula.
  _resolvePackage(arg) {
    const pkg = arg.trim() || this.cfg.package;
    if (!pkg) {
      console.log("No formula set. Use 'package <name>' or pass one inline.");
    } else if (arg.trim()) {
      this.cfg.package = pkg; // inline formula becomes the session default
    }
    return pkg;
  }

  // Split `arg` into `[formula, maxVersions]`. A trailing integer token is the
  // MAX cap; the rest is the formula. On invalid MAX, prints and returns nulls.
  _parsePackageAndMax(arg) {
    let tokens = arg.split(/\s+/).filter(Boolean);
    let maxVersions = null;
    if (tokens.length) {
      const last = tokens[tokens.length - 1];
      const candidate = /^-?\d+$/.test(last) ? parseInt(last, 10) : null;
      if (candidate !== null) {
        if (candidate < 1) {
          console.log("MAX must be a positive integer.");
          return [null, null];
        }
        maxVersions = candidate;
        tokens = tokens.slice(0, -1);
      }
    }
    return [this._resolvePackage(tokens.join(" ")), maxVersions];
  }

  // -- configuration commands -------------------------------------------

  // registry [URL]  — set or show the source URL ('none' to clear).
  do_registry(arg) {
    arg = arg.trim();
    if (arg) this.cfg.indexUrl = arg.toLowerCase() === "none" ? null : arg;
    console.log(`source = ${this.sdk.effectiveIndexUrl() || "(brew default)"}`);
  }

  // package [NAME]  — set or show the default formula.
  do_package(arg) {
    arg = arg.trim();
    if (arg) this.cfg.package = arg;
    console.log(`package = ${this.cfg.package || "(unset)"}`);
  }

  // limit [N|none]  — only probe the newest N versions ('none' = all).
  do_limit(arg) {
    arg = arg.trim().toLowerCase();
    if (!arg) {
      console.log(`limit = ${this.cfg.limit !== null ? this.cfg.limit : "none"}`);
      return;
    }
    if (arg === "none") {
      this.cfg.limit = null;
    } else if (/^-?\d+$/.test(arg)) {
      this.cfg.limit = Math.max(1, parseInt(arg, 10));
    } else {
      console.log("limit must be an integer or 'none'.");
      return;
    }
    console.log(`limit = ${this.cfg.limit !== null ? this.cfg.limit : "none"}`);
  }

  // output [PATH]  — set or show the JSON report path.
  do_output(arg) {
    arg = arg.trim();
    if (arg) this.cfg.output = arg;
    console.log(`output = ${this.cfg.output}`);
  }

  // venv [DIR]  — set or show the download cache dir (resets the env).
  do_venv(arg) {
    arg = arg.trim();
    if (arg) {
      this.cfg.venvDir = arg;
      this.sdk.invalidateVenv(); // force re-create against the new dir
    }
    console.log(`venv-dir = ${this.cfg.venvDir}`);
  }

  // brew [VERSION|none]  — set or show the brew version the test env checks.
  do_brew(arg) {
    arg = arg.trim();
    if (arg) {
      this.cfg.brewVersion = arg;
      this.sdk.invalidateVenv(); // re-check on next fetch-test
    }
    console.log(`brew-version = ${this.cfg.brewVersion}`);
  }

  // verbose [on|off]  — stream full brew output so fetches are debuggable.
  do_verbose(arg) {
    arg = arg.trim().toLowerCase();
    if (["on", "true", "1", "yes"].includes(arg)) {
      this.cfg.verbose = true;
    } else if (["off", "false", "0", "no"].includes(arg)) {
      this.cfg.verbose = false;
    } else if (arg === "") {
      this.cfg.verbose = !this.cfg.verbose; // bare 'verbose' toggles
    } else {
      console.log("Usage: verbose [on|off]");
      return;
    }
    console.log(`verbose = ${this.cfg.verbose ? "on" : "off"}`);
  }

  // show  — print the current session settings.
  do_show() {
    console.log(`  source    = ${this.sdk.effectiveIndexUrl() || "(brew default)"}`);
    console.log(`  package   = ${this.cfg.package || "(unset)"}`);
    console.log(`  limit     = ${this.cfg.limit !== null ? this.cfg.limit : "none"}`);
    console.log(`  output    = ${this.cfg.output}`);
    console.log(`  venv-dir  = ${this.cfg.venvDir}`);
    console.log(`  brew      = ${this.cfg.brewVersion}`);
    console.log(`  verbose   = ${this.cfg.verbose ? "on" : "off"}`);
  }

  // env  — show the resolved homebrew/TLS env vars (process.env or default).
  do_env() {
    const cfg = this.sdk.resolveEnv();
    const width = Math.max(...Object.keys(cfg).map((k) => k.length));
    for (const name of Object.keys(ENV_DEFAULTS)) {
      const source = name in process.env ? "env" : "default";
      const value = cfg[name] !== "" ? cfg[name] : "(unset)";
      console.log(`  ${name.padEnd(width)} = ${value}  [${source}]`);
    }
  }

  // -- action commands ---------------------------------------------------

  // versions [FORMULA]  — list versions the registry advertises.
  async do_versions(arg) {
    const pkg = this._resolvePackage(arg);
    if (!pkg) return;
    const payload = await this.sdk.versionsOutput(pkg);
    this._lastPayload = { command: "versions", ...payload };
    const versions = payload.versions;
    if (!versions.length) {
      console.log("No versions found.");
      return;
    }
    console.log(`${payload.count} version(s) for '${pkg}':`);
    console.log("  " + versions.join(", "));
  }

  // find [FORMULA]  — fetch-test until the first token that works.
  async do_find(arg) {
    const pkg = this._resolvePackage(arg);
    if (!pkg) return;
    try {
      const report = await this.sdk.find(pkg);
      this._lastPayload = { command: "find", ...report.toDict() };
    } catch (e) {
      if (e instanceof HomebrewVersionsError) console.log(e.message);
      else throw e;
    }
  }

  // test [FORMULA] [MAX]  — fetch-test versions (newest first), write report.
  async do_test(arg) {
    const [pkg, maxVersions] = this._parsePackageAndMax(arg);
    if (!pkg) return;
    const opts = maxVersions === null ? {} : { limit: maxVersions };
    try {
      const report = await this.sdk.test(pkg, opts);
      this._lastPayload = { command: "test", ...report.toDict() };
    } catch (e) {
      if (e instanceof HomebrewVersionsError) console.log(e.message);
      else throw e;
    }
  }

  // run ARGS...  — pass raw CLI args straight through the SDK to main.
  async do_run(arg) {
    const argv = splitTokens(arg) || [];
    if (!argv.length) {
      console.log("Usage: run <formula> [--source URL] [--limit N] [--first-only]");
      return;
    }
    await this.sdk.run(argv);
  }

  // help  — list commands.
  do_help() {
    const docs = [
      ["registry [URL]", "set or show the source URL ('none' to clear)"],
      ["index [URL]", "alias for registry"],
      ["package [NAME]", "set or show the default formula"],
      ["limit [N|none]", "only probe the newest N versions ('none' = all)"],
      ["output [PATH]", "set or show the JSON report path"],
      ["venv [DIR]", "set or show the download cache dir"],
      ["brew [VERSION|none]", "set or show the brew version the test env checks"],
      ["verbose [on|off]", "stream full brew output so fetches are debuggable"],
      ["show", "print the current session settings"],
      ["env", "show the resolved homebrew/TLS env vars"],
      ["versions [FORMULA]", "list versions the registry advertises"],
      ["find [FORMULA]", "fetch-test until the first token that works"],
      ["test [FORMULA] [MAX]", "fetch-test versions, write the JSON report"],
      ["run ARGS...", "pass raw CLI args straight through to main"],
      ["quit / exit", "leave the shell"],
    ];
    console.log("Commands (append --output=PATH to save output; versions/find/test write JSON):");
    for (const [name, desc] of docs) console.log(`  ${name.padEnd(22)} ${desc}`);
  }

  // -- dispatch ----------------------------------------------------------

  // Map a command name to its handler (honoring aliases).
  _handler(name) {
    const aliases = { index: "registry", exit: "quit", "?": "help", EOF: "quit" };
    const resolved = aliases[name] || name;
    if (resolved === "quit") return () => this._quit();
    const fn = this[`do_${resolved}`];
    return fn ? fn.bind(this) : null;
  }

  _quit() {
    console.log("Bye.");
    return true; // stop
  }

  /**
   * Dispatch one command, honoring an inline `--output=PATH` flag.
   *
   * Any command may carry `--output=PATH` (or `--output PATH`): the flag is
   * stripped before dispatch and the result is written to PATH. Data commands
   * (`versions`/`find`/`test`) stash a structured payload in `this._lastPayload`
   * and that is serialized to JSON; any other command falls back to the console
   * text, teed to the screen as it is captured. `run` is exempt — it forwards
   * `--output` to the underlying tool unchanged.
   */
  async onecmd(line) {
    const trimmed = line.trim();
    if (!trimmed) return false; // empty line: do nothing
    const cmdName = trimmed.split(/\s+/)[0];
    const [clean, outputPath] = extractOutput(line);

    const exec = async (text) => {
      const name = text.trim().split(/\s+/)[0];
      const rest = text.trim().slice(name.length).trim();
      const handler = this._handler(name);
      if (!handler) {
        console.log(`*** Unknown syntax: ${text.trim()}`);
        return false;
      }
      return (await handler(rest)) === true;
    };

    if (outputPath === null || cmdName === "run") {
      return exec(line);
    }

    this._lastPayload = null; // cleared so a stale payload can't leak through
    // Tee stdout to an in-memory buffer while still printing to the screen.
    const buf = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, ...a) => {
      buf.push(typeof chunk === "string" ? chunk : chunk.toString());
      return origWrite(chunk, ...a);
    };
    let stop = false;
    try {
      stop = await exec(clean);
    } finally {
      process.stdout.write = origWrite;
      this._writeOutput(outputPath, buf.join(""));
    }
    return stop;
  }

  /**
   * Write the last command's result to `outputPath`.
   *
   * Prefers the structured `this._lastPayload` (rendered as JSON) so data
   * commands produce a machine-readable file; falls back to the captured
   * console text for commands that have no structured form (e.g. `show`).
   */
  _writeOutput(outputPath, capturedText) {
    const content =
      this._lastPayload !== null
        ? JSON.stringify(this._lastPayload, null, 2) + "\n"
        : capturedText;
    try {
      fs.writeFileSync(outputPath, content);
      console.log(`Output written to ${outputPath}`);
    } catch (exc) {
      console.error(`Could not write output to ${outputPath}: ${exc.message}`);
    }
  }

  // Run the interactive read-eval-print loop.
  cmdloop() {
    console.log(INTRO);
    return new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.setPrompt(PROMPT);
      rl.prompt();
      rl.on("line", async (line) => {
        rl.pause();
        let stop = false;
        try {
          stop = await this.onecmd(line);
        } catch (e) {
          console.error(e?.stack || String(e));
        }
        if (stop) {
          rl.close();
          return;
        }
        rl.resume();
        rl.prompt();
      });
      rl.on("SIGINT", () => {
        console.log("\nInterrupted.");
        rl.close();
        process.exitCode = 130;
      });
      rl.on("close", () => resolve());
    });
  }
}

/**
 * Run a single command from `argv`, or an interactive shell if none.
 *
 * Passing args runs them as one REPL command line and exits — this is what makes
 * the shell usable as a container entrypoint:
 *
 *     docker run <image> versions wget       // -> REPL: `versions ...`
 *     docker run <image> run wget --limit 5  // -> batch via main.main
 *     docker run -it <image>                 // -> interactive REPL
 */
export async function main(argv = null) {
  argv = argv === null ? process.argv.slice(2) : argv;
  const repl = new HomebrewVersionsREPL();
  if (argv.length) {
    await repl.onecmd(argv.join(" ")); // one-shot, then exit
    return 0;
  }
  await repl.cmdloop();
  return 0;
}

import { fileURLToPath } from "node:url";
import path from "node:path";
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then((code) => process.exit(code ?? process.exitCode ?? 0));
}
