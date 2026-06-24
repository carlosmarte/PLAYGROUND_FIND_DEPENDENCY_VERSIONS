# Tasks — subprocess buffer / verbose hardening

Work checklist. Each tool = edit `node-cli/<tool>/main.mjs` **and**
`python-cli/<tool>/main.py`, keeping the twins in parity. Apply the canonical
snippets from `README.md`. After each tool: `node --check` + `python3 -m
py_compile`.

`pip` is the reference and is **done**.

---

## Tier 1 — subprocess discovery (apply Fix A + B + C to the discovery query)

For each: add the `stripVerbose` / `_strip_verbose` helper, wrap the discovery
options with it, add `maxBuffer: 50 * 1024 * 1024` to the discovery `spawnSync`
(Node), and upgrade the error block to surface the signal name (both langs).
**Use the tool's real verbose flag** (see per-tool note) in the strip predicate.

- [x] **alpine** — `apk policy`. Verbose flag: `-v` repeat (`^-v+$` matches). Node B also covers spawnSync at 164/210/226.
- [x] **conda** — `conda search --json`. Verbose: `-v` repeat (`^-v+$`).
- [x] **debian** — `apt-cache madison`. Verbose: `-o Debug::pkgAcquire=true` (**not** `-v`); strip predicate must match the `-o Debug::*` pair, or better: build discovery options without the debug toggle.
- [x] **go** — `go list -m -versions`. Verbose: `-x` (strip `-x`, not `-v`).
- [x] **helm** — `helm search repo`. Verbose: `--debug` (strip `--debug`).
- [x] **rpm** — `dnf --showduplicates list`. Verbose: `-v` repeat (`^-v+$`).
- [x] **spm** — `git ls-remote --tags`. Verbose: `--verbose` (strip `--verbose`).
- [x] **uv** — `uv pip index versions`. Verbose: `-v` repeat (`^-v+$`). Node C: discovery currently only handles ENOENT/non-zero — add the `status===null`/signal branch like pip. Python C: line ~134 prints `e.stderr.strip()` → add signal fallback.

---

## Tier 2 — special-cased subprocess discovery

- [x] **pacman** — `pacman -Si` injects `--debug`; strip `--debug` from the discovery options (Fix A). Add `maxBuffer` (B). The discovery error path parses stdout, not stderr — make it surface the signal name when the child is killed (C).
- [x] **npm** — `npm view <pkg> versions --json`. **Decide Fix A:** npm verbosity is `--loglevel <level>`, not `^-v+$`. If `npmOptions(cfg)` can emit `--loglevel verbose/silly`, strip that pair for discovery; otherwise A is N/A. Apply B (spawnSync ~115) + C (error ~121, currently `blank`).
- [x] **pnpm** — same as npm (`pnpm view ... --json`, `--loglevel`). Decide A; apply B (~114) + C (~120, `blank`).
- [x] **winget** — `winget show --versions`. Options are **not** injected into discovery → **Fix A N/A**. Apply B (discovery ~133 + install ~283) + C (~137 — already `|| "unknown error"`, add signal name).

---

## Tier 3 — HTTP-primary discovery with subprocess fallback (fix the fallback path)

- [x] **ansible** — Galaxy v3 API primary; CLI `ansible-galaxy` fallback injects `galaxyOptions`. Apply A to the fallback command, B to its spawnSync (~172), C to its error block (~178 node / ~168 py).
- [x] **hex** — Hex API primary; `mix hex.info` fallback injects `hexOptions` (`--debug`). Strip `--debug` for the fallback (A); B (~186); C (~190 node / ~179 py).

---

## Tier 4 — HTTP-fetch discovery (Fix A N/A — harden secondary spawnSync only)

Discovery is a pure HTTP fetch, so **do not** add Fix A. For each tool, add Fix B
(`maxBuffer`) to every output-capturing `spawnSync` (version-pin + install/resolve
test) and Fix C (signal name) to their error blocks.

### 4a — highest (version-pin error block prints blank on signal-kill)
- [x] **puppet** — spawnSync 189/293; error 197 node / 185 py (`blank`).
- [x] **stack** — spawnSync 192/304; error 196 node / 186 py (`blank`).
- [x] **twine** — spawnSync 216/309/335; error 220 node / 186 py (`blank`).
- [x] **cargo** — spawnSync 176/199/306/308; error 204 node / 188 py.
- [x] **chocolatey** — spawnSync 234/340; error 244 node / 221 py.
- [x] **cabal** — spawnSync 164/202; error 207 node / 183 py.

### 4b — medium (already non-blank; add signal name + maxBuffer)
- [x] **clojars** — spawnSync 243; error 254 node / 226 py (`enh`).
- [x] **gradle** — spawnSync 316; error 324/331 node / 325 py (`enh`).
- [x] **homebrew** — spawnSync 298; error 313 node / 300 py (`enh`).
- [x] **jsr** — spawnSync 355; error 367 node / 334 py (`enh`).
- [x] **terraform** — spawnSync 179/297; error 304 py (`enh`).

### 4c — lower (mostly just Fix B maxBuffer; verify error blocks)
- [x] **vagrant** — spawnSync 272 (returncode-only handling).
- [x] **vcpkg** — spawnSync 274 (returncode-only handling).
- [x] **cpan** — spawnSync 199/286.
- [x] **cran** — spawnSync 226 (Rscript version check).
- [x] **dart** — spawnSync 197/212/303.
- [x] **docker** — spawnSync 218/307; error 221.
- [x] **maven** — confirm install-path spawnSync (none in discovery).
- [x] **nuget** — confirm install-path spawnSync (none in discovery).
- [x] **poetry** — confirm install-path spawnSync (none in discovery).

---

## Done / reference
- [x] **pip** — Fix A + B + C applied (`node-cli/pip/main.mjs`, `python-cli/pip/main.py`). Canonical implementation.

## Per-tool definition of done
1. Node: every output-capturing `spawnSync` has `maxBuffer: 50 * 1024 * 1024`.
2. Node + Python: every subprocess error block surfaces the signal name (no blank
   message on signal-kill).
3. Discovery query (subprocess tools only) no longer injects the verbose flag.
4. `node --check` and `python3 -m py_compile` pass.
5. mjs and py twins remain behaviorally identical.
</content>
