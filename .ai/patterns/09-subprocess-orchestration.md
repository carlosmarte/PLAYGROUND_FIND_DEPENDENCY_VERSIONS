# 09 — Subprocess Orchestration of an External Tool

## Problem

The job is to drive an external command-line tool (a package manager, compiler,
linter) and react to its results. Done naively — string-concatenated shell
commands, ignored exit codes, swallowed output — it is fragile and insecure.

## Solution

A disciplined wrapper around process execution:

1. **Build an argument *list*, never a shell string.** Each flag/value is a
   separate list element, so values are never shell-interpreted (no injection).
2. **Inject a deliberate child environment**, derived from resolved config
   (see [04 Layered Config Resolution](04-layered-config-resolution.md)), rather
   than leaking the parent's ambient env unchanged.
3. **Adapt config → flags** in one helper, so callers compose commands from
   building blocks (`base_cmd + options + target_flags`).
4. **Check the exit code explicitly** and **classify failures** — capture
   stdout/stderr, extract a compact message (e.g. last non-empty line) for logs.
5. Keep the invoked tool's **version pinned** so behavior is reproducible
   (see [15 Pinned Tool Version](15-pinned-version.md)).

## Language-neutral sketch

```
function toolFlags(cfg) -> list:           # config → CLI flags
    flags = []
    if cfg.verbose > 0: flags += verbosityFlag(cfg.verbose)
    flags += ["--timeout", cfg.timeout, "--retries", cfg.retries]
    return flags

function childEnv(cfg) -> map:              # deliberate child environment
    env = copyOf(parentEnv)
    for k in TLS_VARS: if cfg[k]: env[k] = cfg[k]
    return env

function discover(name, cfg):
    cmd = [tool, "subcommand", name] + toolFlags(cfg)
    result = run(cmd, captureOutput=true, env=childEnv(cfg))
    if result.code != 0:
        log(lastNonEmptyLine(result.stderr)); fail()
    return parse(result.stdout)
```

## In this project

`main.py`:
- `pip_options(cfg)` builds the flag list (`-v`, `--cert`, `--trusted-host`,
  `--timeout`, `--retries`).
- `subprocess_env(cfg)` builds the child env with TLS cert vars applied.
- `get_available_versions` / `_ensure_pip_version` / `test_installations` all
  compose `[sys.executable, "-m", "pip", ...] + pip_options(cfg) + extras`,
  run with `subprocess.run(..., env=subprocess_env(cfg))`, and branch on
  `returncode`.
- `_last_line(text)` extracts a compact error/log line for the report.

## Portability notes

- The **arg-list-not-shell-string** rule is the single most important security
  point — it holds in every language (`subprocess.run([...])`, Go `exec.Command`,
  Rust `Command::arg`, Node `execFile`/`spawn` with an args array). Never
  `system("tool " + userInput)`.
- Extract output parsing (e.g. regex over a known line) into its own function so
  it can be unit-tested without spawning a process.
- Related: [10 Dual-Mode Output](10-dual-mode-output.md),
  [11 Incremental Persistence](11-incremental-persistence.md).
