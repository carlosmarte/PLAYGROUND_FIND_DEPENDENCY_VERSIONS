# syntax=docker/dockerfile:1

# alpine-versions — probe which versions of a package install from a (custom)
# Alpine apk repository. cli.mjs is the entrypoint: pass REPL commands as
# container args, or run with no args (and `-it`) for an interactive shell.
#
#   docker build -t alpine-versions:lts-latest .
#
#   docker run --rm alpine-versions:lts-latest versions busybox
#   docker run --rm alpine-versions:lts-latest test busybox 5
#   docker run --rm alpine-versions:lts-latest run busybox --limit 5 --first-only -v
#   docker run --rm -it alpine-versions:lts-latest                 # interactive REPL
#
# The tool builds a throwaway apk root inside the container and installs each
# version into it, so the container needs network access to your repository.
# Point it at a repository and capture the report via a mount:
#   docker run --rm -e APK_REPOSITORY=https://reg/main \
#       -v "$PWD/out:/app/out" alpine-versions:lts-latest \
#       run busybox --repository https://reg/main --output out/report.json -v

# node:22-alpine ships the native `apk` CLI (apk-tools) the tool wraps, alongside
# the Node runtime for the wrapper itself. (The reference node:22-slim image is
# Debian-based and has no apk, so the Alpine variant is used here.)
ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-alpine

# apk-tools version the tool expects (advisory; matches main.DEFAULT_APK_VERSION).
ARG APK_VERSION=2.14.4

# Unbuffered-ish stdout so verbose install streaming surfaces in real time
# through `docker run`/`docker logs`.
ENV NODE_ENV=production

WORKDIR /app

# Only the three runtime modules + manifest (tests/CI/sandboxes excluded via
# .dockerignore).
COPY package.json main.mjs sdk.mjs cli.mjs ./

# Run as a non-root user; /app stays writable for the throwaway test root and
# the JSON report the tool writes to the working directory.
RUN adduser -D -u 10001 app \
    && chown -R app:app /app
USER app

# Container args become a single REPL command line; no args -> interactive shell.
ENTRYPOINT ["node", "cli.mjs"]
CMD []
