# 11 — Incremental Crash-Safe Persistence

## Problem

A batch loop does expensive, failure-prone work per item (network installs,
builds). If the process crashes or is interrupted near the end, you don't want to
lose all the results collected so far.

## Solution

**Persist the full accumulated result set after *every* iteration**, overwriting
the output file each time. Each item appends to an in-memory list; immediately
after, re-serialize the whole list to disk. A crash at any point leaves a valid
file containing every completed item.

- Write the **entire** collection each time (simple, always-valid file) rather
  than appending fragments that could leave a half-written record.
- Combine with an **early-exit** option (stop after the first success / after N)
  that still leaves the file consistent.

## Language-neutral sketch

```
results = []
for i, item in enumerate(items):
    outcome = doExpensiveWork(item)        # may fail/raise
    results.append(record(item, outcome))

    writeWholeFile(outputPath, serialize(results))   # checkpoint every iter

    if firstOnly and outcome.ok:
        break
```

## In this project

`main.py`'s `test_installations` appends a success/failure dict per version, then
does `with open(output_json, "w") as f: json.dump(results, f, indent=4)` **inside
the loop**, after every iteration — with an explicit comment: "Persist after
every iteration so partial results survive a crash." `first_only` breaks early
once an installable version is found, and the file is already current.

## Portability notes

- Rewriting the whole file each iteration is fine for small/medium result sets
  and guarantees a valid document. For large sets, switch to append-only
  newline-delimited records (JSONL) or an atomic write (write temp + rename) to
  avoid a torn file if the process dies mid-write.
- The pattern trades a little I/O for durability — appropriate when each
  iteration is far more expensive than a file write (true for network installs).
- Related: [09 Subprocess Orchestration](09-subprocess-orchestration.md),
  [06 Structured Result Object](06-structured-result-object.md).
