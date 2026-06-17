# syntax=docker/dockerfile:1

# pnpm-versions — probe which versions of a package install from a (custom)
# registry. cli.mjs is the entrypoint: pass REPL commands as container args, or
# run with no args (and `-it`) for an interactive shell.
#
#   docker build -t pnpm-versions:lts-latest .
#
#   docker run --rm pnpm-versions:lts-latest versions left-pad
#   docker run --rm pnpm-versions:lts-latest test left-pad 5
#   docker run --rm pnpm-versions:lts-latest run left-pad --limit 5 --first-only -v
#   docker run --rm -it pnpm-versions:lts-latest                 # interactive REPL
#
# The tool itself is Node.js but drives the `pnpm` CLI: it builds a throwaway
# temp project inside the container and pnpm-adds each version into it, so the
# container needs network access to your registry. Point it at a registry and
# capture the report via a mount:
#   docker run --rm -e NPM_CONFIG_REGISTRY=https://reg \
#       -v "$PWD/out:/app/out" pnpm-versions:lts-latest \
#       run left-pad --registry https://reg --output out/report.json -v

# node:22-slim ships Node.js + corepack; we enable pnpm via corepack below.
FROM node:22-slim

# pnpm pinned to match main.DEFAULT_PNPM_VERSION so install-tests run against a known pnpm.
ARG PNPM_VERSION=9.15.0

# Unbuffered-ish stdout so verbose install streaming surfaces in real time
# through `docker run`/`docker logs`.
ENV NODE_ENV=production

# Node runs the tool itself; pnpm (via corepack) is the CLI it wraps.
RUN corepack enable \
    && corepack prepare "pnpm@${PNPM_VERSION}" --activate

WORKDIR /app

# Only the three runtime modules + manifest (tests/CI/sandboxes excluded via
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
