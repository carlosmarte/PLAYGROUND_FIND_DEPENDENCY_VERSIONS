# 02 — Stateless Engine of Pure Functions

## Problem

If the core logic reads global state (environment variables, ambient config)
directly, it becomes hard to test, hard to reuse with different settings, and
its behavior depends on hidden inputs.

## Solution

Implement the engine as **free functions** that receive an already-**resolved
config object** as an explicit parameter. The engine never reaches for global
state on its own; a caller resolves config once and threads it through every
call.

- Each function takes `(domain_inputs..., config)` and returns data.
- Config resolution (env, defaults, overrides) happens *above* the engine and is
  passed down — see [04 Layered Config Resolution](04-layered-config-resolution.md).
- Side effects (process spawning, file writes) are explicit and parameterized
  (output path, working dir), not hard-coded.

## Language-neutral sketch

```
function resolveConfig(overrides?) -> Config      # done once, at the edge

function discover(name, indexUrl, config) -> list
function setup(dir, version, config)      -> handle
function execute(handle, name, targets, outPath, config) -> results
```

A caller resolves config once, then passes the same `config` to each function.

## In this project

`main.py` functions all accept `cfg=None` and resolve lazily, but callers
(`sdk.py`, `main.main`) resolve `cfg` **once** and pass it through every call:

```python
cfg = resolve_env()
index_url = resolve_index_url(args.index_url, cfg)
versions = get_available_versions(args.package, index_url, cfg, ...)
pip_path = setup_venv(args.venv_dir, pip_version, cfg, ...)
test_installations(pip_path, ..., cfg=cfg, ...)
```

The `cfg=None` default ("resolve if not given") keeps each function callable in
isolation while still letting the orchestrator resolve once.

## Portability notes

- This is classic **dependency injection** via a parameter, not a framework.
- In strongly-typed languages, make `Config` an explicit immutable struct/record;
  the "resolve once, pass down" rule replaces ambient globals.
- The `cfg=None → resolve()` convenience default is a Python idiom; in other
  languages prefer an explicit overload or a required parameter so the
  "resolve once at the edge" discipline is enforced by the type system.
- Related: [04 Layered Config Resolution](04-layered-config-resolution.md).
