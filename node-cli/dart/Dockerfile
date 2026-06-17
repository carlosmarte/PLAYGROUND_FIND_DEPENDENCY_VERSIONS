# syntax=docker/dockerfile:1

# dart-versions — probe which versions of a package install from a (custom) pub
# server. cli.mjs is the entrypoint: pass REPL commands as container args, or run
# with no args (and `-it`) for an interactive shell.
#
#   docker build -t dart-versions:lts-latest .
#
#   docker run --rm dart-versions:lts-latest versions http
#   docker run --rm dart-versions:lts-latest test http 5
#   docker run --rm dart-versions:lts-latest run http --limit 5 --first-only -v
#   docker run --rm -it dart-versions:lts-latest                 # interactive REPL
#
# The tool builds a throwaway Dart package inside the container and runs
# `dart pub add` for each version into it, so the container needs network access
# to your pub server. Point it at a server and capture the report via a mount:
#   docker run --rm -e PUB_HOSTED_URL=https://pub.dev \
#       -v "$PWD/out:/app/out" dart-versions:lts-latest \
#       run http --hosted-url https://pub.dev --output out/report.json -v
#
# NOTE: version discovery uses the pub.dev HTTP JSON API (global fetch, Node 18+)
# and needs no toolchain. The install-tests (`find`/`test`/`run`) shell out to
# the `dart` CLI, which is NOT present in node:22-slim. To exercise install-tests
# in this image you must install the Dart SDK (e.g. copy it in from the
# `dart:stable` image, or apt-install it) and ensure `dart` is on PATH.

ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-slim

# dart version the test package expects (matches main.DEFAULT_DART_VERSION).
ARG DART_VERSION=3.5.4

# Unbuffered-ish stdout so verbose install streaming surfaces in real time
# through `docker run`/`docker logs`.
ENV NODE_ENV=production

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
