# 06 — Structured Result Object

## Problem

The engine produces raw records (a list of dicts/maps). If every caller has to
re-derive "which ones succeeded?" or "what was the first success?" from those
raw records, the derivation logic is duplicated and inconsistent.

## Solution

Wrap the raw records in a **typed result object** that exposes **derived
accessors** as computed properties. The object carries the raw data plus context
(what was run, where output went) and answers the common questions itself.

- Store the raw records once; compute views on demand (don't pre-compute and
  risk staleness).
- Implement collection protocols (iterable, length) so the result feels native.
- Keep derivations as read-only properties, not methods with side effects.
- Give the object a **serialization surface** — a `toDict()`/`to_dict()` that
  returns a JSON-able view (the derived rollups *and* the raw records), plus
  thin `to_json()` / `write_json(path)` wrappers — so any consuming script can
  persist or pipe the result without scraping console text.

## Language-neutral sketch

```
record Result:
    target:     string
    sourceUrl:  string?
    outputPath: string
    records:    list = []

    property succeeded   -> [r.id for r in records if r.ok]
    property failed      -> [r.id for r in records if not r.ok]
    property firstSuccess-> succeeded[0] or null

    iterator() -> iterate records
    length()   -> count of records

    method toDict()          -> { target, sourceUrl, count, succeeded, failed, records }
    method toJson(indent)    -> serialize toDict()
    method writeJson(path)   -> write toJson() to path, return path
```

## In this project

`sdk.py`'s `@dataclass Report` wraps `results` (raw dicts from `main.py`) and
exposes `installable`, `failed`, `first_installable` as `@property` accessors,
plus `__iter__`/`__len__` so a `Report` can be looped and sized like a list. The
engine returns raw dicts; the SDK is the only place that knows how to interpret
them.

`Report` also carries the serialization surface: `to_dict()` returns the
canonical JSON-able shape (the rollups plus the raw per-version `results`), and
`to_json()` / `write_json(path)` build on it (`sdk.mjs` mirrors this as
`toDict()` / `toJson()` / `writeJson()` — note the lowercase-`json` name dodges
the `JSON.stringify` `toJSON` protocol hook). The REPL's inline `--output=PATH`
flag is a thin consumer of this surface: for the data commands it writes
`to_dict()` as JSON rather than teeing console text. The index-URL key in
`to_dict()` mirrors each ecosystem's own field name (`index_url`, `galaxy_server`
for ansible-galaxy, `forge_server` for puppet, `vagrant_server` for vagrant),
keeping the serialized object faithful to its domain model.

## Portability notes

- Python `@property` + `@dataclass`; TS getters on a class; Go methods on a
  struct (`func (r Result) Succeeded() []string`); Rust methods returning
  iterators; Java records with derived accessor methods.
- Implementing the language's collection interface (iterable/`IntoIterator`/
  `Iterable`) makes the object ergonomic at call sites.
- Keep the wrapper in the SDK layer so the engine stays dumb about presentation —
  see [01 Layered Funnel](01-layered-funnel-architecture.md).
