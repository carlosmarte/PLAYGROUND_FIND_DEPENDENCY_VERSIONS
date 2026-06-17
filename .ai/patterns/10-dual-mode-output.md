# 10 — Dual-Mode Output (Stream vs Capture)

## Problem

For a long-running child process you want two behaviors from one code path:
- **quiet mode** — capture all output, surface only a summary; and
- **verbose/debug mode** — show the child's output **live** (so the user sees a
  slow build or a hang in real time) *while still* capturing it for the report.

You don't want two divergent implementations.

## Solution

Branch on a single `verbose` flag at the execution boundary:

- **Quiet:** run the process with output captured into buffers; read
  `(code, stdout, stderr)` after it exits.
- **Verbose:** run with stdout+stderr merged into a pipe; iterate the pipe line
  by line, echoing each line live **and** appending it to a buffer; after exit,
  feed the captured buffer into the same downstream record/report logic.

Optionally bump the child tool's *own* verbosity flag when in verbose mode (but
only if the user hasn't already set one — see the guard below).

## Language-neutral sketch

```
function stream(cmd, env) -> (code, combinedText):
    proc   = spawn(cmd, stdoutPipe, mergeStderrIntoStdout, env)
    chunks = []
    for line in proc.stdout:           # live
        writeStdout(line); flush()
        chunks.append(line)
    proc.wait()
    return proc.code, join(chunks)

function execOne(cmd, env, verbose):
    if verbose:
        if not hasVerbosityFlag(cmd): cmd += toolVerbosityFlag
        code, out = stream(cmd, env)
        return code, out, out            # same text serves stdout & stderr slots
    else:
        r = run(cmd, capture=true, env=env)
        return r.code, r.stdout, r.stderr
```

## In this project

`main.py`: `_stream(cmd, env)` echoes each line live while collecting it and
returns `(returncode, combined_output)`. `test_installations` branches on
`verbose`: verbose path calls `_stream` (and appends `-v` via `_has_verbose`
guard only if no verbosity flag is present); quiet path calls
`subprocess.run(..., capture_output=True)`. Both feed the same
success/failure-record construction.

## Portability notes

- The key is a **single downstream sink**: whichever branch ran, the captured
  text flows into the same result-building code, so the report is identical in
  shape regardless of mode.
- Merging stderr into stdout for the live stream preserves ordering as the user
  would see it in a terminal.
- The `_has_verbose` guard is a small but important detail: **don't double up**
  flags the user already provided.
- Related: [09 Subprocess Orchestration](09-subprocess-orchestration.md).
