# 13 — One-Shot Entrypoint / Container-Friendly CLI

## Problem

An interactive shell is great for humans, but the same binary needs to run
non-interactively too — as a container entrypoint, in CI, or from a script — and
maintaining a *separate* batch entrypoint duplicates dispatch logic.

## Solution

Make the program's entrypoint **reuse the interactive command dispatcher** for a
single line:

- **No args** → start the interactive loop.
- **Args present** → join them into *one command line*, dispatch it through the
  same command handler the REPL uses, then exit.

The same command vocabulary works in both modes; there is exactly one place that
interprets a command. Handle interrupt signals to return a conventional exit code.

## Language-neutral sketch

```
function main(argv):
    repl = new Repl()
    try:
        if argv is non-empty:
            repl.dispatchOneLine(join(argv, " "))   # one-shot, then exit
            return 0
        repl.loop()                                  # interactive
    catch Interrupt:
        return 130                                   # conventional SIGINT code
    return 0
```

This makes the container contract clean:

```
run <image>                      → interactive shell (with a TTY)
run <image> versions numpy       → dispatches REPL line "versions numpy", exits
run <image> run numpy --limit 5  → dispatches "run numpy --limit 5", exits
```

## In this project

`cli.py`'s `main(argv)`: builds one `PipVersionsREPL`, and if argv is present
calls `repl.onecmd(" ".join(argv))` then returns; otherwise `repl.cmdloop()`.
`KeyboardInterrupt` returns `130`. The Dockerfile's
`ENTRYPOINT ["python", "cli.py"]` + `CMD []` makes container args become exactly
that one REPL command (documented in both `cli.py` and the Dockerfile).

## Portability notes

- The exit code `130` (128 + SIGINT) is a POSIX convention worth keeping across
  languages.
- Pairing `ENTRYPOINT` (fixed program) with `CMD []` (default empty args) is the
  container idiom that lets `docker run <image> <args>` flow straight into your
  one-shot dispatcher — see [17 Container Packaging](17-container-packaging.md).
- Related: [12 REPL Over a Config View](12-repl-over-config.md).
