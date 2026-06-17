# syntax=docker/dockerfile:1

# spm-versions — probe which versions (semver git tags) of a Swift package
# resolve. cli.mjs is the entrypoint: pass REPL commands as container args, or run
# with no args (and `-it`) for an interactive shell.
#
#   docker build -t spm-versions:lts-latest .
#
#   docker run --rm spm-versions:lts-latest versions https://github.com/apple/swift-argument-parser.git
#   docker run --rm spm-versions:lts-latest test https://github.com/apple/swift-argument-parser.git 5
#   docker run --rm spm-versions:lts-latest run https://github.com/apple/swift-argument-parser.git --limit 5 --first-only -v
#   docker run --rm -it spm-versions:lts-latest                # interactive REPL
#
# The tool builds a throwaway Swift package inside the container and runs
# `swift package resolve` against each pinned version, so the container needs
# network access to the package's git repo. Capture the report via a mount:
#   docker run --rm -v "$PWD/out:/app/out" spm-versions:lts-latest \
#       run https://github.com/apple/swift-argument-parser.git --output out/report.json -v

# NOTE: the tool shells out to `git` (discovery) and the `swift` toolchain
# (resolve-tests). The canonical base here is node:22-slim per the reference
# pattern; it ships neither git nor swift by default. We install git below (it is
# in Debian's repos). The `swift` toolchain is NOT in Debian's default repos and
# is large — `versions` (git ls-remote) works as-is, but `find`/`test` require a
# swift toolchain on PATH (base on the official swift image with Node added, or
# install Swift for Linux). Discovery + smoke work without swift.
ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-slim

# swift toolchain version this image targets (matches main.DEFAULT_SWIFT_VERSION
# in spirit; the actual swift is whatever the host/toolchain provides).
ARG SWIFT_TOOLCHAIN_VERSION=6.0.3

# Unbuffered-ish stdout so verbose resolve streaming surfaces in real time
# through `docker run`/`docker logs`.
ENV NODE_ENV=production

# git (for tag discovery) + CA certs; swift must be added separately if you need
# resolve-tests (see note above).
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Only the three runtime modules + manifest (tests/CI/sandboxes excluded via
# .dockerignore).
COPY package.json main.mjs sdk.mjs cli.mjs ./

# Run as a non-root user; /app stays writable for the throwaway test package and
# the JSON report the tool writes to the working directory.
RUN useradd --create-home --uid 10001 app \
    && chown -R app:app /app
USER app

# Container args become a single REPL command line; no args -> interactive shell.
ENTRYPOINT ["node", "cli.mjs"]
CMD []
