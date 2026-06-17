# syntax=docker/dockerfile:1

# jsr-versions — probe which versions of a package install from the JSR
# registry. cli.mjs is the entrypoint: pass REPL commands as container args, or
# run with no args (and `-it`) for an interactive shell.
#
#   docker build -t jsr-versions:lts-latest .
#
#   docker run --rm jsr-versions:lts-latest versions @std/encoding
#   docker run --rm jsr-versions:lts-latest test @std/encoding 5
#   docker run --rm jsr-versions:lts-latest run @std/encoding --limit 5 --first-only -v
#   docker run --rm -it jsr-versions:lts-latest                 # interactive REPL
#
# Discovery hits the JSR HTTP JSON metadata (global fetch); the install-tests
# build a throwaway temp project inside the container and run `npx jsr add` into
# it, so the container needs network access to the registry. Point it at a
# registry and capture the report via a mount:
#   docker run --rm -e JSR_URL=https://jsr.io \
#       -v "$PWD/out:/app/out" jsr-versions:lts-latest \
#       run @std/encoding --registry https://jsr.io --output out/report.json -v

# node:22-slim ships Node.js + npx — the tool runs on Node and shells out to
# `npx jsr` for the install-tests.
ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-slim

# jsr/deno toolchain version recorded by main.DEFAULT_JSR_VERSION ("none" =
# whatever `npx jsr` resolves at run time).
ARG JSR_VERSION=none

# Unbuffered-ish stdout so verbose install streaming surfaces in real time
# through `docker run`/`docker logs`.
ENV NODE_ENV=production

WORKDIR /app

# Only the runtime modules + manifest (tests/CI/sandboxes excluded via
# .dockerignore).
COPY package.json main.mjs sdk.mjs cli.mjs ./

# Run as a non-root user; /app stays writable for the throwaway test project and
# the JSON report the tool writes to the working directory.
RUN useradd --create-home --uid 10001 app \
    && chown -R app:app /app
USER app

# Container args become a single REPL command line; no args -> interactive shell.
ENTRYPOINT ["node", "cli.mjs"]
CMD []
