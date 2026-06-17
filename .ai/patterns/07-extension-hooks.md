# 07 — Extension Hooks (Template Method)

## Problem

Callers want to customize *part* of a multi-step operation (e.g. filter inputs
before work, post-process results after) without copying the whole orchestration
or threading callbacks through every call site.

## Solution

Make the orchestration a **template method** that calls **no-op hook methods** at
well-defined points. The default hooks return their input unchanged; a subclass
overrides only the hooks it cares about. The fixed skeleton stays in the base
class; the variable steps are the hooks.

```
operation():
    inputs  = gather()
    inputs  = beforeStep(inputs)     # hook — default: return inputs
    raw     = doWork(inputs)
    result  = wrap(raw)
    return    afterStep(result)      # hook — default: return result
```

## Language-neutral sketch

```
class Client:
    method beforeStep(inputs) -> inputs:   return inputs    # override me
    method afterStep(result)  -> result:   return result    # override me

    method _run():                          # the template skeleton
        items  = self.discover()
        items  = self.beforeStep(items)
        result = self.wrap(self.execute(items))
        return   self.afterStep(result)

# caller
class Quiet(Client):
    method beforeStep(items): return items[:3]
    method afterStep(result): result.records = [r for r in result if r.ok]; return result
```

## In this project

`sdk.py` declares `before_probe(package, versions)` and `after_probe(report)`,
both returning their argument unchanged by default. `_probe()` (the skeleton)
calls `before_probe` after discovery and `after_probe` before returning. The
module docstring shows a `QuietSDK` subclass overriding both.

## Portability notes

- OO languages: protected virtual methods (Template Method / GoF).
- Functional or composition-first languages: pass the hooks as optional
  function parameters with identity defaults (`beforeStep = identity`), which is
  the same idea without inheritance.
- Keep hooks **pure transforms** (input → output) rather than `void` callbacks so
  they compose and the data flow stays explicit.
- Related: [01 Layered Funnel](01-layered-funnel-architecture.md).
