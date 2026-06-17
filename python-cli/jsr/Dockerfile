# syntax=docker/dockerfile:1

# jsr-versions — probe which versions of a package install from the JSR
# registry. cli.py is the entrypoint: pass REPL commands as container args, or
# run with no args (and `-it`) for an interactive shell.
#
#   docker build -t jsr-versions:lts-latest .
#
#   docker run --rm jsr-versions:lts-latest versions @std/encoding
#   docker run --rm jsr-versions:lts-latest test @std/encoding 5
#   docker run --rm jsr-versions:lts-latest run @std/encoding --limit 5 --first-only -v
#   docker run --rm -it jsr-versions:lts-latest                 # interactive REPL
#
# Discovery hits the JSR HTTP JSON metadata; the install-tests build a throwaway
# temp project inside the container and run `npx jsr add` into it, so the
# container needs network access to the registry. Point it at a registry and
# capture the report via a mount:
#   docker run --rm -e JSR_URL=https://jsr.io \
#       -v "$PWD/out:/app/out" jsr-versions:lts-latest \
#       run @std/encoding --registry https://jsr.io --output out/report.json -v

# node:22-slim ships Node.js + npx — the tool (Python) shells out to `npx jsr`.
FROM node:22-slim

# jsr/deno toolchain version recorded by main.DEFAULT_JSR_VERSION ("none" =
# whatever `npx jsr` resolves at run time).
ARG JSR_VERSION=none

# Unbuffered stdout so verbose install streaming surfaces in real time through
# `docker run`/`docker logs`; skip .pyc clutter in the image.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# Python 3 runs the tool itself; `npx jsr` is the CLI it wraps for install-tests.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Only the three runtime modules (tests/CI/venvs excluded via .dockerignore).
COPY main.py sdk.py cli.py ./

# Run as a non-root user; /app stays writable for the throwaway test project and
# the JSON report the tool writes to the working directory.
RUN useradd --create-home --uid 10001 app \
    && chown -R app:app /app
USER app

# Container args become a single REPL command line; no args -> interactive shell.
ENTRYPOINT ["python3", "cli.py"]
CMD []
