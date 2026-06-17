# 03 — Configuration Object as Session State

## Problem

A session has many tunable settings (target, source URL, output path, limits,
verbosity, …). Passing them as a long positional argument list is error-prone,
and scattering them as separate mutable fields makes "the current settings" hard
to inspect or hand off.

## Solution

Gather all session settings into **one record/struct with a sensible default per
field**. The object *is* the session state. Higher layers hold a reference to it
and mutate fields directly; lower layers read it. A single object can be printed,
copied, or serialized to show "everything the run will use."

- Every field has a default, so a default-constructed config is immediately usable.
- The presentation layer treats the config as the source of truth (it is a *view*
  onto the config; see [12 REPL Over a Config View](12-repl-over-config.md)).

## Language-neutral sketch

```
record Config:
    target:     string?  = null
    sourceUrl:  any      = UNSET        # see pattern 05
    workDir:    string   = ".work"
    outputPath: string   = "report.json"
    toolVersion:string?  = DEFAULT_VERSION
    limit:      int?     = null
    verbose:    bool     = false
    envOverrides: map    = {}
```

## In this project

`sdk.py`'s `@dataclass Config` holds `package`, `index_url`, `venv_dir`,
`output`, `pip_version`, `limit`, `verbose`, `env`. The REPL's `cfg` property
returns `self.sdk.config`, and every `do_*` command reads/writes those fields.
`do_show` simply prints them back.

## Portability notes

- Python `@dataclass`; TypeScript `interface` + object; Go struct with field
  tags; Rust struct with `Default` impl; Java record or builder.
- Prefer defaults co-located with the field declaration so "construct with
  nothing" yields a valid object.
- One field may need a third state beyond value/null — see
  [05 Unset Sentinel](05-unset-sentinel.md).
- For per-call overrides without mutating the session object, accept an optional
  override and merge (this project does this for `limit` in `test(limit=…)`).
