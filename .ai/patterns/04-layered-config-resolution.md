# 04 — Layered Config Resolution

## Problem

A setting can come from several sources with a natural priority: a hard-coded
default, an environment variable, and an explicit command-line/API override. You
need one predictable rule for which wins, applied consistently everywhere.

## Solution

Define an ordered **precedence chain** and resolve it in one place:

```
effective = explicit_override  ??  environment  ??  built-in_default
```

Keep a single table of `{ name: industry_standard_default }`. Resolution reads
each name from the environment, falls back to the default, then folds in
non-null explicit overrides. Resolution returns a **fresh** map each call (no
shared mutable state). Specialized resolvers (e.g. "which source URL?") layer a
second precedence chain on top of the resolved map.

## Language-neutral sketch

```
DEFAULTS = { "VERBOSE": "0", "SOURCE_URL": "https://default/...", ... }

function resolveEnv(overrides?) -> map:
    cfg = { name: env(name) ?? default  for name, default in DEFAULTS }
    if overrides: cfg.update(non-null entries of overrides)
    return cfg                         # fresh map each call

function resolveSourceUrl(explicit, cfg) -> string?:
    return explicit ?? cfg["SOURCE_URL"] ?? cfg["FALLBACK_URL"] ?? null
```

A second concern: translate the resolved map into the **target tool's flags**
and into a **child-process environment** (two small adapter functions), so the
rest of the code never reasons about raw env var names.

## In this project

- `ENV_DEFAULTS` in `main.py` documents each var with an inline comment naming
  the "industry standard" fallback (e.g. `PIP_DEFAULT_TIMEOUT = "15"`).
- `resolve_env(overrides)` implements `defaults < os.environ < overrides`.
- `resolve_index_url(explicit, cfg)` is the layered second chain
  (`--index-url > $PIP_INDEX_URL > $PYTHON_REGISTRY_URL > pypi.org`).
- `pip_options(cfg)` adapts the map into CLI flags; `subprocess_env(cfg)` adapts
  it into a child-process environment.

## Portability notes

- Keep the **default table** as data, not scattered `getenv("X") || "y"` calls —
  it doubles as documentation and can be surfaced to users (this project's REPL
  `env` command prints each value plus whether it came from `env` or `default`).
- Returning a fresh map per call avoids action-at-a-distance bugs.
- The "explicit overrides win, but only when non-null" rule pairs with
  [05 Unset Sentinel](05-unset-sentinel.md) when *null itself* is a meaningful value.
- Related: [02 Stateless Engine](02-stateless-engine.md) (resolve once, pass down).
