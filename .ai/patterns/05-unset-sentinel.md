# 05 — Unset Sentinel (Three-State Argument)

## Problem

Sometimes `null`/`None` is itself a **meaningful value**, distinct from "the
caller didn't supply anything." Example: `sourceUrl = null` may mean "use the
tool's built-in default and pass no flag," while "argument omitted" must mean
"resolve it from the environment." A single nullable field cannot express both.

## Solution

Introduce a unique **sentinel object** that means *"not supplied"*, distinct from
both a real value and an explicit `null`. The field becomes tri-state:

| State | Meaning |
|-------|---------|
| `UNSET` (sentinel) | resolve from environment / default chain |
| `null` | caller explicitly wants "none" (e.g. omit the flag entirely) |
| a value | use exactly this |

The sentinel is a private, identity-compared singleton (`is`/`===`, not `==`).

## Language-neutral sketch

```
UNSET = unique_singleton()             # private module-level object

record Config:
    sourceUrl: any = UNSET

function effectiveUrl(config):
    if config.sourceUrl is UNSET:       # identity comparison
        return resolveFromEnv()
    return config.sourceUrl             # may legitimately be null
```

The same sentinel doubles as a default for **method parameters** that should
mean "fall back to the session config," distinguishing "argument omitted" from
"explicit null passed."

## In this project

`sdk.py` defines `_UNSET = object()`. `Config.index_url` defaults to `_UNSET`.
`effective_index_url()` checks `is _UNSET` to decide between env-resolution and
an explicit value. Methods like `available_versions(limit=_UNSET)` and
`test(limit=_UNSET)` use the same sentinel to mean "use `config.limit`," so a
caller can still pass `limit=None` to mean "no cap."

## Portability notes

- Python: `_UNSET = object()` compared with `is`.
- TypeScript: a unique `const UNSET = Symbol("unset")`.
- Go: a package-private pointer/var compared by identity, or a `*T` where the
  outer "absent" is `nil` and inner null is modeled separately.
- Rust: model directly in the type system — `Option<Option<T>>`, or a dedicated
  `enum { Unset, None, Some(T) }`. The sentinel hack is mostly a dynamic-language
  workaround; prefer an explicit three-variant enum when the language allows.
- Related: [03 Configuration Object](03-configuration-object.md),
  [04 Layered Config Resolution](04-layered-config-resolution.md).
