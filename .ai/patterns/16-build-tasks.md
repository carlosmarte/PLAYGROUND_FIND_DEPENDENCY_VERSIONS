# 16 — Self-Documenting Idempotent Build Tasks

## Problem

A project needs repeatable developer tasks (set up an isolated environment, lint,
smoke-test, run, clean). Re-running setup should be cheap; new contributors
should discover tasks without reading the build file; CI should reuse the same
tasks humans run.

## Solution

A task runner (Makefile or equivalent) with four properties:

1. **Project-local isolation** — all tooling installs into a local environment so
   the host stays untouched.
2. **Idempotent setup via a stamp/sentinel** — a marker file records "fully
   provisioned"; the setup target depends on it, so a second `setup` is a no-op.
3. **Self-documenting help** — the default target scrapes per-target `## comment`
   annotations and prints them, so `make` with no args lists the commands.
4. **Layered verification targets** — cheap checks compose into bigger ones
   (`lint` → `smoke` → `ci`), and CI runs the exact same target a developer can.

Optional dependency manifests are installed only **if present**, so a
stdlib-only project needs none but the same file scales up later.

## Language-neutral sketch

```
DEFAULT_GOAL := help

help:               # scrape "## text" annotations into a list
    grep '## ' tasks-file | format

env:                # create local isolated environment
    create-local-env

setup: stamp        # idempotent: depends on the stamp marker
stamp: env
    install/pin tooling
    install manifests IF present
    touch stamp     # subsequent `setup` is a no-op

lint:  setup ;  compile/static-check sources
smoke: setup ;  import + exercise entrypoints
ci:    lint smoke   # exactly what CI runs, locally reproducible
clean: ;            remove envs + caches
```

## In this project

`Makefile`:
- `.venv` local environment; `STAMP := $(VENV)/.stamp` guards `setup` so it is a
  no-op once provisioned.
- `help` (the `.DEFAULT_GOAL`) `grep`/`awk`s `## ` annotations into a colored list.
- `REQUIREMENTS`/`DEV_REQUIREMENTS` installed only `if [ -f … ]` (the project is
  stdlib-only, so they're skipped today).
- `lint` byte-compiles the modules; `smoke` imports them and exercises the CLI +
  SDK; `ci: lint smoke` is the documented "what CI runs"; `clean` removes envs and
  caches. `docker-build`/`docker-run` wrap the image with overridable
  `IMAGE`/`TAG`/`ARGS`.

## Portability notes

- The pattern is task-runner-agnostic: `make`, `just`, `npm scripts`, `task`,
  `cargo xtask` all support local isolation, an idempotency guard, and a help
  target.
- The **stamp-file idempotency** trick (`target: stamp; stamp: deps … ; touch
  stamp`) generalizes anywhere a "did we already provision?" check is wanted
  without re-running expensive installs.
- Keep `ci` defined in terms of the same targets developers call — one definition,
  no drift between local and CI.
