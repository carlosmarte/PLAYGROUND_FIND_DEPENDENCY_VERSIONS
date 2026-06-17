# syntax=docker/dockerfile:1

# rpm-versions — probe which versions of a package install from a (custom)
# RPM/dnf repository. cli.mjs is the entrypoint: pass REPL commands as container
# args, or run with no args (and `-it`) for an interactive shell.
#
#   docker build -t rpm-versions:lts-latest .
#
#   docker run --rm rpm-versions:lts-latest versions bash
#   docker run --rm rpm-versions:lts-latest test bash 5
#   docker run --rm rpm-versions:lts-latest run bash --limit 5 --first-only -v
#   docker run --rm -it rpm-versions:lts-latest                 # interactive REPL
#
# The tool builds a throwaway download dir inside the container and downloads
# each version into it, so the container needs network access to your
# repository. Point it at a repo and capture the report via a mount:
#   docker run --rm -e DNF_REPOSITORY=fedora \
#       -v "$PWD/out:/app/out" rpm-versions:lts-latest \
#       run bash --repository fedora --output out/report.json -v

# NOTE: the tool shells out to the native `dnf` CLI for both discovery and
# download-tests. The canonical base here is node:22-slim per the reference
# pattern, but node:22-slim is Debian-based and ships APT, NOT dnf. To actually
# run discovery/install-tests you must either (a) base on a Fedora image with
# Node added, or (b) install dnf into this image. The structure below keeps the
# node:22-slim base; dnf MUST be present on PATH for `versions`/`find`/`test` to
# work. (`node --help`/smoke and SDK construction work without dnf.)
ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-slim

# dnf version the tool expects (advisory; matches main.DEFAULT_DNF_VERSION).
ARG DNF_VERSION=4.21.1

# Unbuffered-ish stdout so verbose install streaming surfaces in real time
# through `docker run`/`docker logs`.
ENV NODE_ENV=production

WORKDIR /app

# Only the three runtime modules + manifest (tests/CI/sandboxes excluded via
# .dockerignore).
COPY package.json main.mjs sdk.mjs cli.mjs ./

# Run as a non-root user; /app stays writable for the throwaway download dir and
# the JSON report the tool writes to the working directory.
RUN useradd --create-home --uid 10001 app \
    && chown -R app:app /app
USER app

# Container args become a single REPL command line; no args -> interactive shell.
ENTRYPOINT ["node", "cli.mjs"]
CMD []
