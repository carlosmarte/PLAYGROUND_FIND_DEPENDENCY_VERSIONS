# 14 — Ergonomic API Surface

## Problem

A capable SDK class is great for sessions, but common one-off uses ("just list
the versions") shouldn't require constructing an object, and callers shouldn't
have to import the engine to get its constants.

## Solution

Three small ergonomics layered on top of the class:

1. **Module-level convenience funnels** — free functions that construct the
   client, run one operation, and return the result, for the common one-liners.
   They are thin: `f(x, **opts) = Client(x, **opts).operation()`.
2. **Alternate constructor from CLI args** — a `from_argv` factory that builds a
   fully-configured client from a parsed argument list, so the programmatic and
   command-line surfaces accept identical inputs.
3. **Re-exported constants** — surface the engine's public constants from the SDK
   module so callers depend only on the SDK, not the engine internals.

## Language-neutral sketch

```
# re-export so callers import only the SDK
DEFAULT_VERSION = engine.DEFAULT_VERSION
DEFAULTS        = engine.DEFAULTS

class Client:
    static fromArgv(argv) -> Client:        # alternate constructor
        ns = engine.parseArgs(argv)
        return Client(Config(... mapped from ns ...))

# one-shot funnels (each = construct + one call)
function listVersions(target, **opts): return Client(target, **opts).available()
function findFirst(target, **opts):    return Client(target, **opts).find()
function run(argv):                     return Client().run(argv)
```

## In this project

`sdk.py`:
- Re-exports `DEFAULT_PIP_VERSION` and `ENV_DEFAULTS` from `main`.
- `PipVersionsSDK.from_argv(argv)` builds a client from a `main`-style argv list,
  mirroring the CLI (absent `--index-url` → `_UNSET`; `--pip-version none` →
  keep bootstrapped pip).
- Module-level `versions()`, `find()`, `test()`, `run()` are one-shot funnels
  documented as `external → SDK → main`.

## Portability notes

- "Construct + one call" free functions are the dynamic-language analog of
  static helper methods (`Client.listVersions(...)` in Java/C#) — provide
  whichever idiom your language favors.
- An `fromArgv`/`fromArgs` factory keeps the CLI and library inputs in lockstep:
  the same parser feeds both. Keep the parser in the engine so there is one
  source of truth for flags.
- Re-exporting constants prevents callers from reaching into engine internals,
  preserving the layering in [01 Layered Funnel](01-layered-funnel-architecture.md).
