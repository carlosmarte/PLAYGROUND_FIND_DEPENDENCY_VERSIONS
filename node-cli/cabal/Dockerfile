# syntax=docker/dockerfile:1

# cabal-versions — probe which versions of a package fetch from a (custom)
# Hackage registry. cli.mjs is the entrypoint: pass REPL commands as container
# args, or run with no args (and `-it`) for an interactive shell.
#
#   docker build -t cabal-versions:lts-latest .
#
#   docker run --rm cabal-versions:lts-latest versions aeson
#   docker run --rm cabal-versions:lts-latest test aeson 5
#   docker run --rm cabal-versions:lts-latest run aeson --limit 5 --first-only -v
#   docker run --rm -it cabal-versions:lts-latest                 # interactive REPL
#
# The tool builds a throwaway fetch sandbox inside the container and runs
# `cabal get` for each version, so the container needs network access to your
# registry. Point it at a registry and capture the report via a mount:
#   docker run --rm -e CABAL_REMOTE_REPO=https://hackage.haskell.org \
#       -v "$PWD/out:/app/out" cabal-versions:lts-latest \
#       run aeson --index-url https://hackage.haskell.org --output out/report.json -v

# haskell slim ships cabal + GHC. The tool itself is a Node script that merely
# shells out to cabal, so Node is installed on top. (The reference node:22-slim
# image has no cabal, so the Haskell base image is used here instead and Node is
# layered in via NodeSource.)
ARG HASKELL_VERSION=9.8
FROM haskell:${HASKELL_VERSION}-slim

# cabal version the tool expects (matches main.DEFAULT_CABAL_VERSION). The base
# image ships a cabal; we update its package index so fetch-tests resolve.
ARG CABAL_VERSION=3.12.1.0
ARG NODE_VERSION=22

# Unbuffered-ish stdout so verbose fetch streaming surfaces in real time through
# `docker run`/`docker logs`.
ENV NODE_ENV=production \
    CABAL_REMOTE_REPO=https://hackage.haskell.org

# Node (to run the tool) + ca-certificates; refresh the cabal package index for
# the fetch-tests.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && curl -fsSL "https://deb.nodesource.com/setup_${NODE_VERSION}.x" | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && cabal update

WORKDIR /app

# Only the three runtime modules + manifest (tests/CI/sandboxes excluded via
# .dockerignore).
COPY package.json main.mjs sdk.mjs cli.mjs ./

# Run as a non-root user; /app stays writable for the throwaway fetch sandbox
# and the JSON report the tool writes to the working directory.
RUN useradd --create-home --uid 10001 app \
    && chown -R app:app /app
USER app

# Container args become a single REPL command line; no args -> interactive shell.
ENTRYPOINT ["node", "cli.mjs"]
CMD []
