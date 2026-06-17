# syntax=docker/dockerfile:1

# stack-versions — probe which versions of a package resolve from a (custom)
# Stackage/Hackage registry. cli.mjs is the entrypoint: pass REPL commands as
# container args, or run with no args (and `-it`) for an interactive shell.
#
#   docker build -t stack-versions:lts-latest .
#
#   docker run --rm stack-versions:lts-latest versions aeson
#   docker run --rm stack-versions:lts-latest test aeson 5
#   docker run --rm stack-versions:lts-latest run aeson --limit 5 --first-only -v
#   docker run --rm -it stack-versions:lts-latest                 # interactive REPL
#
# The tool builds a throwaway resolve sandbox inside the container — a per-version
# stack project pinning one `extra-dep` — and runs `stack build --dry-run`, so the
# container needs network access to your registry. Point it at a registry and
# capture the report via a mount:
#   docker run --rm -e STACK_RESOLVER=lts \
#       -v "$PWD/out:/app/out" stack-versions:lts-latest \
#       run aeson --index-url https://hackage.haskell.org --output out/report.json -v

ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-slim

# stack version the tool expects (matches main.DEFAULT_STACK_VERSION). The
# resolve-tests shell out to the `stack` CLI; node:22-slim does not ship the
# Haskell toolchain, so we install stack via the upstream script. (GHC is pulled
# in by stack on first build; for a leaner image, base on haskell:*-slim and add
# Node instead.)
ARG STACK_VERSION=3.1.1

# Unbuffered-ish stdout so verbose resolve streaming surfaces in real time
# through `docker run`/`docker logs`.
ENV NODE_ENV=production \
    STACK_RESOLVER=lts

# Install stack (used by `stack build --dry-run` during resolve-tests). Version
# discovery itself hits the Hackage JSON API over global fetch and needs no stack.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && curl -sSL https://get.haskellstack.org/ | sh \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Only the runtime modules + manifest (tests/CI/sandboxes excluded via
# .dockerignore).
COPY package.json main.mjs sdk.mjs cli.mjs ./

# Run as a non-root user; /app stays writable for the throwaway resolve sandbox
# and the JSON report the tool writes to the working directory.
RUN useradd --create-home --uid 10001 app \
    && chown -R app:app /app
USER app

# Container args become a single REPL command line; no args -> interactive shell.
ENTRYPOINT ["node", "cli.mjs"]
CMD []
