# Patterns Catalog

This directory documents the design patterns used in this project, described in
**language-agnostic** terms so the same structure can be re-implemented in any
language (TypeScript, Go, Rust, Java, etc.), not just the reference Python here.

The reference implementation is a small command-line tool with three layers:

```
  interactive shell  ─┐
  external scripts   ─┼─►  SDK (programmatic API)  ─►  Engine (core logic)
  one-shot CLI       ─┘
```

Each pattern file states the **problem**, the **solution shape**, a
**language-neutral sketch**, where it appears in this project, and
**portability notes** for other languages.

## Index

| # | Pattern | One-line summary |
|---|---------|------------------|
| 01 | [Layered Funnel Architecture](01-layered-funnel-architecture.md) | Every caller reaches the core through one narrowing path of thin layers. |
| 02 | [Stateless Engine of Pure Functions](02-stateless-engine.md) | Core logic is free functions that take resolved config as a parameter. |
| 03 | [Configuration Object as Session State](03-configuration-object.md) | One mutable record holds all settings; layers are views onto it. |
| 04 | [Layered Config Resolution](04-layered-config-resolution.md) | Effective value = defaults < environment < explicit override, via a precedence chain. |
| 05 | [Unset Sentinel (Three-State Argument)](05-unset-sentinel.md) | A distinct "not supplied" marker, separate from a meaningful null. |
| 06 | [Structured Result Object](06-structured-result-object.md) | Return a typed record with derived/computed accessors, not raw maps. |
| 07 | [Extension Hooks (Template Method)](07-extension-hooks.md) | No-op overridable hooks let subclasses inject behavior without forking. |
| 08 | [Lazy Provisioning with Cache + Invalidation](08-lazy-provisioning-cache.md) | Build an expensive resource on first use; cache it; expose explicit invalidation. |
| 09 | [Subprocess Orchestration of an External Tool](09-subprocess-orchestration.md) | Wrap an external CLI: build arg lists, inject env, capture, classify errors. |
| 10 | [Dual-Mode Output (Stream vs Capture)](10-dual-mode-output.md) | One code path that either streams live or captures quietly. |
| 11 | [Incremental Crash-Safe Persistence](11-incremental-persistence.md) | Re-serialize the full result set after every iteration so partial work survives. |
| 12 | [REPL Over a Config View](12-repl-over-config.md) | An interactive shell that owns no logic—just maps lines onto the SDK. |
| 13 | [One-Shot Entrypoint / Container-Friendly CLI](13-oneshot-entrypoint.md) | Args become a single interactive command, then exit. |
| 14 | [Ergonomic API Surface](14-ergonomic-api-surface.md) | Convenience funnels, alternate constructors, and re-exported constants. |
| 15 | [Pinned Tool Version for Reproducibility](15-pinned-version.md) | One canonical version constant, echoed across code, build, and image. |
| 16 | [Self-Documenting Idempotent Build Tasks](16-build-tasks.md) | Stamp-guarded setup, discoverable help, layered lint→smoke→ci targets. |
| 17 | [Hardened Container Packaging](17-container-packaging.md) | Slim pinned base, non-root user, minimal build context, args→command. |

## How these fit together

- **01–02** are the structural backbone (layers + a pure core).
- **03–06** are the data-shape patterns (how config and results travel).
- **07–08** are lifecycle/extensibility patterns.
- **09–11** are the execution patterns (driving an external process safely).
- **12–14** are the surface patterns (how callers actually invoke the tool).
- **15–17** are the packaging/operational patterns.
