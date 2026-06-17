# 15 — Pinned Tool Version for Reproducibility

## Problem

The tool drives an external program (a package manager) whose behavior —
resolution, security/cooldown policy, output format — changes between versions.
If each environment (dev, CI, container, the throwaway test env) uses whatever
version happens to be installed, results aren't reproducible and parsing breaks.

## Solution

Declare **one canonical version constant** and propagate it to *every* place the
tool runs, so dev, CI, the container image, and the isolated test environment all
exercise the same version. Make it overridable for deliberate experiments, but
default everything to the same pin.

- A single source-of-truth constant in code.
- Build/automation files default to the *same* value (and say so in a comment).
- The constant is injected wherever an environment is provisioned.

## Language-neutral sketch

```
# code
DEFAULT_TOOL_VERSION = "X.Y.Z"            # one source of truth

function setupEnv(dir, version = DEFAULT_TOOL_VERSION):
    pinToolTo(dir, version)               # the test env runs this exact version

# build automation (defaults to the same value)
TOOL_VERSION ?= X.Y.Z

# container image (build arg defaults to the same value)
ARG TOOL_VERSION=X.Y.Z
RUN install-tool "==${TOOL_VERSION}"
```

## In this project

The pip version `26.1.1` is pinned in three coordinated places, each commented to
say it matches the others:
- `main.py`: `DEFAULT_PIP_VERSION = "26.1.1"`, used by `setup_venv` /
  `_ensure_pip_version` to pin the throwaway test venv, overridable via
  `--pip-version` or the REPL `pip` command.
- `Makefile`: `PIP_VERSION ?= 26.1.1` ("pinned to the same version main.py
  defaults to, so the dev environment matches the resolver/cooldown behaviour").
- `Dockerfile`: `ARG PIP_VERSION=26.1.1` ("pinned to match
  main.DEFAULT_PIP_VERSION").

## Portability notes

- Keep one authoritative value and have the others *default* to it (`?=`, `ARG …=`,
  a single constant). Comments cross-referencing the source prevent silent drift.
- Make it overridable (CLI flag, env var, build arg) so a user can test a
  different version without editing code.
- This is the project's reason for existing: pinning the package manager makes
  its **install-time policy** (e.g. release cooldown) deterministic. Reproducible
  tooling is a prerequisite for trustworthy supply-chain checks.
