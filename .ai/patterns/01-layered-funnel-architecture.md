# 01 — Layered Funnel Architecture

## Problem

Multiple kinds of caller need the same capability: an interactive user, an
external script, a batch/CI invocation. If each caller talks to the core
directly, logic and validation get duplicated and drift apart.

## Solution

Route **every** caller through one narrowing funnel of thin layers, where each
layer has a single responsibility and delegates downward:

```
  presentation layer(s)   →   programmatic layer   →   engine layer
  (shell / one-shot CLI)      (SDK / client API)       (pure core logic)
```

- The **engine** holds the actual work and no presentation concerns.
- The **SDK** owns session configuration and structured results; it is the
  single supported programmatic entry point.
- The **presentation** layers (REPL, CLI flags, HTTP handler, …) hold *no*
  business logic — they parse input, map it onto the SDK, and render output.

The invariant: *anything a presentation layer can do, an external caller can do
by driving the same SDK directly.* No capability is reachable only through the UI.

## Language-neutral sketch

```
# engine.*          — free functions, no I/O policy of its own
function discover(input, config) -> data
function execute(input, config) -> rawResults

# sdk.*             — the one funnel
class Client(config):
    method discover() -> Typed         # wraps engine.discover
    method execute()  -> Result        # wraps engine.execute, returns structured
    method run(rawArgs) -> exitCode     # passthrough to engine's CLI main

# presentation.*    — thin views
repl_command(line)  -> parse, call client.method(), print
cli_main(argv)      -> parse, call client.method(), return exit code
```

## In this project

- `main.py` — engine (`get_available_versions`, `test_installations`, …).
- `sdk.py` — `PipVersionsSDK`, the single funnel; even raw CLI passthrough goes
  `SDK.run → main.main`.
- `cli.py` — REPL that holds "no engine logic of its own" (see its module docstring).

Both `cli.py` and external scripts are documented as driving the *same*
`sdk.PipVersionsSDK`.

## Portability notes

- The layering is independent of language. In Go/Rust, "engine" is a package of
  functions, "SDK" is a struct with methods, "presentation" is `main` + a REPL.
- Keep the dependency arrows pointing **one way** (presentation → sdk → engine).
  The engine must never import the SDK or presentation.
- Related: [02 Stateless Engine](02-stateless-engine.md),
  [12 REPL Over a Config View](12-repl-over-config.md),
  [14 Ergonomic API Surface](14-ergonomic-api-surface.md).
