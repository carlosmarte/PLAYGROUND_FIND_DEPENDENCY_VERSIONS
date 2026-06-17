# 17 — Hardened Container Packaging

## Problem

Packaging a CLI tool into a container naively produces a bloated, root-running
image that copies the entire working tree (including local environments, caches,
and secrets) and is awkward to invoke.

## Solution

A small set of container hygiene practices:

1. **Slim, pinned base image** — a minimal base at a pinned major version (via a
   build `ARG`), not `latest`.
2. **Pin the in-image tool version** to match the code's constant
   (see [15 Pinned Tool Version](15-pinned-version.md)).
3. **Copy only runtime files** — explicitly `COPY` the few source modules; keep
   everything else out via a build-context ignore file.
4. **Run as a non-root user** — create an unprivileged user, own the app dir,
   `USER` down before the entrypoint.
5. **Args-become-command entrypoint** — `ENTRYPOINT` is the fixed program; `CMD
   []` defaults args empty, so `run <image> <args>` flows into the one-shot
   dispatcher (see [13 One-Shot Entrypoint](13-oneshot-entrypoint.md)).
6. **Predictable runtime env** — unbuffered stdout (so streamed output appears
   live), no bytecode clutter.

## Language-neutral sketch

```
ARG BASE_VERSION=<major>
FROM <slim-base>:${BASE_VERSION}-slim

ARG TOOL_VERSION=X.Y.Z
ENV UNBUFFERED=1 NO_BYTECODE=1

RUN install-tool "==${TOOL_VERSION}"
WORKDIR /app
COPY <only the runtime source files> ./        # nothing else

RUN create-unprivileged-user app && chown -R app /app
USER app

ENTRYPOINT ["<program>", "<entry-script>"]      # fixed program
CMD []                                           # args → one-shot command
```

Build-context ignore file excludes envs, caches, build files, and docs so they
never enter the image (and never leak into it).

## In this project

- `Dockerfile`: `ARG PYTHON_VERSION=3.13` → `python:${PYTHON_VERSION}-slim`;
  `ARG PIP_VERSION=26.1.1` pinned to `main.DEFAULT_PIP_VERSION`;
  `ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1`; `COPY main.py sdk.py cli.py`
  (only the three runtime modules); a `useradd --uid 10001 app` non-root user
  owning `/app`; `ENTRYPOINT ["python", "cli.py"]` + `CMD []`.
- `.dockerignore` excludes `.venv/`, `.venv-test-install/`, `__pycache__/`,
  `*.pyc`, the report JSON, `Makefile`, `Dockerfile`, `.dockerignore`,
  `.gitignore`, and `*.md` — keeping the build context to the runtime modules.

## Portability notes

- These practices are language-agnostic; the only specifics are the base image
  and tool names. A multi-stage build can further separate build-time deps from
  the runtime image when compilation is involved.
- The build-context ignore file matters for **both** size and **secret hygiene**:
  excluding local env dirs and dotfiles keeps credentials and machine-specific
  state out of the image.
- Keep `/app` writable by the app user when the tool writes runtime artifacts
  (here, a throwaway env and a JSON report) — non-root does not mean read-only.
