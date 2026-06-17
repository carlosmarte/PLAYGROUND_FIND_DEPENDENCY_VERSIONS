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
```

## In this project

`sdk.py`'s `@dataclass Report` wraps `results` (raw dicts from `main.py`) and
exposes `installable`, `failed`, `first_installable` as `@property` accessors,
plus `__iter__`/`__len__` so a `Report` can be looped and sized like a list. The
engine returns raw dicts; the SDK is the only place that knows how to interpret
them.

## Portability notes

- Python `@property` + `@dataclass`; TS getters on a class; Go methods on a
  struct (`func (r Result) Succeeded() []string`); Rust methods returning
  iterators; Java records with derived accessor methods.
- Implementing the language's collection interface (iterable/`IntoIterator`/
  `Iterable`) makes the object ergonomic at call sites.
- Keep the wrapper in the SDK layer so the engine stays dumb about presentation —
  see [01 Layered Funnel](01-layered-funnel-architecture.md).
