# Plan: subprocess buffer / verbose hardening across all CLI tools

## Why

A bug was found and fixed in the **`pip`** tool (`node-cli/pip`, `python-cli/pip`):
when `PIP_VERBOSE=1`, the version-discovery query (`pip index versions`) made pip
emit a line per registry link. That flood overflowed Node's default 1 MB
`spawnSync` buffer, which **killed the child** (`status === null`, `signal` set)
and surfaced a **blank** error string. The same structural template is copied
across **all 35 sibling tools** in `node-cli/*` and `python-cli/*`, so the same
class of defect exists wherever a tool shells out to a package manager.

This plan scans the whole project (done — see `audit-findings.md`) and sequences
the remediation. `pip` is already fixed and serves as the **reference
implementation**.

## The three fixes (canonical form — copied from `pip`)

### Fix A — strip the verbose flag from the *discovery* query
The discovery query only parses a tiny result (one line / a small JSON list), so
the tool's verbose flag is pure noise that can flood the capture buffer. Strip any
`-v`/`-vv`/`-vvv` (regex `^-v+$`) from the options used **only** for that query.

```js
// node — main.mjs
/** pip `options` with any `-v`/`-vv`/`-vvv` verbosity flag removed. */
function stripVerbose(options) {
  return options.filter((o) => !/^-v+$/.test(o));
}
// discovery call site:
const cmd = ["...", pkg, ...stripVerbose(<tool>Options(cfg))];
```
```py
# python — main.py
def _strip_verbose(options):
    """Return ``options`` with any ``-v``/``-vv``/``-vvv`` verbosity flag removed."""
    return [o for o in options if not re.fullmatch(r"-v+", o)]
# discovery call site:
cmd += _strip_verbose(<tool>_options(cfg))
```

> **Per-tool nuance:** some tools express verbosity differently — `helm`/`pacman`
> use `--debug`, `go` uses `-x`, `debian/apt` uses `-o Debug::...`, `git` (spm)
> and `stack`/`twine`/`cpan` use `--verbose`, `npm`/`pnpm` use `--loglevel`,
> `cargo` uses `--verbose` from `CARGO_TERM_VERBOSE`. The **principle** is the
> same (don't feed the verbose flag into the small-result discovery query) but
> the `stripVerbose` predicate must match that tool's actual flag, not just
> `^-v+$`. See the per-tool notes in `tasks.md`.

### Fix B — defensive `maxBuffer` on every output-capturing `spawnSync` (Node only)
Python's `subprocess.run(capture_output=True)` buffers unbounded, so this is
**Node-only**. Add a large guard to every `spawnSync(..., { encoding: "utf8" })`:

```js
const res = spawnSync(BIN, cmd, {
  encoding: "utf8",
  env,
  maxBuffer: 50 * 1024 * 1024, // defensive guard against future verbose output
});
```

### Fix C — surface the signal name when the child was killed
A blank error is worse than useless. When the child is killed by a signal
(Node: `status === null` + `res.signal`; Python: negative `returncode`), stderr is
empty, so fall back to the signal name.

```js
// node
const detail = (res.stderr || "").trim()
  || (res.signal && `terminated by signal ${res.signal}`)
  || (res.error && res.error.message)
  || "unknown error";
```
```py
# python  (add `import signal`)
detail = (e.stderr or "").strip()
if not detail and e.returncode is not None and e.returncode < 0:
    try:
        detail = f"terminated by signal {signal.Signals(-e.returncode).name}"
    except ValueError:
        detail = f"terminated by signal {-e.returncode}"
print(f"Error running '...': {detail or 'unknown error'}", file=sys.stderr)
```

## Scope summary

| Fix | Applies to | Count |
|-----|-----------|-------|
| **A** strip verbose in discovery | tools whose discovery is a subprocess injecting a verbose flag | ~10 tools (× both langs) |
| **B** `maxBuffer` guard | **every** output-capturing `spawnSync` in `node-cli/*` | 34 tools (Node only) |
| **C** signal-name error reporting | **every** subprocess error block in `node-cli/*` + `python-cli/*` | 34 tools (× both langs) |

## Files in this plan

- **`README.md`** — this overview + the canonical fix snippets.
- **`audit-findings.md`** — full per-tool, per-language scan results with file:line.
- **`tasks.md`** — tiered, checkbox work plan with per-tool notes.

## Sequencing (see `tasks.md` for the checklist)

1. **Tier 1 — subprocess discovery (highest impact):** `alpine`, `conda`, `debian`,
   `go`, `helm`, `rpm`, `spm`, `uv` — apply A + B + C to the discovery query.
2. **Tier 2 — special-cased subprocess discovery:** `pacman`, `npm`, `pnpm`,
   `winget` — apply B + C; apply A where the verbose flag is genuinely injected.
3. **Tier 3 — HTTP-primary w/ subprocess fallback:** `ansible`, `hex` — apply
   A + B + C to the CLI fallback path.
4. **Tier 4 — HTTP-fetch discovery (hardening only):** the remaining 20 tools —
   apply B + C to their secondary version-pin / install-test `spawnSync` blocks.
   Fix A does **not** apply (discovery never shells out).

## Verification

- `node --check node-cli/<tool>/main.mjs` and `python3 -m py_compile
  python-cli/<tool>/main.py` for every edited file.
- Spot-check Fix A: with the tool's verbose env set high (e.g. `GO_VERBOSE=3`),
  confirm the discovery command no longer carries the verbose flag (print the
  built `cmd` or diff against `stripVerbose`).
- Keep edits mechanical and identical to the `pip` reference so the polyglot
  twins stay in parity.

> **Note:** line numbers in `audit-findings.md` / `tasks.md` were captured by a
> read-only scan and are *indicative*. Re-confirm each call site at edit time
> (the surrounding code is the source of truth).
</content>
</invoke>
