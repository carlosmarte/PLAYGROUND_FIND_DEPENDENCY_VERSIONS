# 08 — Lazy Provisioning with Cache + Invalidation

## Problem

Some resources are expensive to create (an isolated environment, a connection, a
compiled artifact). You want to build it only when first needed, reuse it across
operations, and rebuild it when a setting that affects it changes.

## Solution

Three coordinated pieces:

1. **Lazy build** — a `ensure_X()` method builds the resource on first call and
   caches the handle; subsequent calls return the cached handle.
2. **Cache** — a nullable field holds the handle (`null` = not yet built).
3. **Explicit invalidation** — an `invalidate_X()` method clears the cache so the
   next `ensure_X()` rebuilds. Callers invoke it after mutating a setting the
   resource depends on.

## Language-neutral sketch

```
class Client:
    field _handle = null

    method ensure() -> handle:
        if self._handle is null:
            self._handle = buildExpensiveResource(self.config...)
        return self._handle

    method invalidate():
        self._handle = null          # next ensure() rebuilds
```

Callers that change a dependency setting must invalidate:

```
method setWorkDir(dir): self.config.workDir = dir; self.invalidate()
```

## In this project

`sdk.py`: `_pip_path` caches the provisioned test-venv pip. `ensure_pip()` builds
it once via `main.setup_venv`. `invalidate_venv()` resets `_pip_path = None`. The
REPL calls `invalidate_venv()` from `do_venv` and `do_pip` because changing the
venv directory or the pinned tool version must force a re-provision.

## Portability notes

- This is **memoization with a manual reset**, scoped to an instance.
- The discipline that matters: every setter for a setting the resource depends on
  must trigger invalidation. Document that coupling (this project notes it in the
  `invalidate_venv` docstring: "Call after changing `config.venv_dir` or
  `config.pip_version`.").
- In concurrent contexts, guard `ensure_X` with a lock / once-cell
  (`sync.Once`, `OnceCell`, lazy_static) instead of a bare null check.
- Related: [03 Configuration Object](03-configuration-object.md),
  [09 Subprocess Orchestration](09-subprocess-orchestration.md).
