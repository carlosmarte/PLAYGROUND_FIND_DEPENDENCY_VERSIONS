# syntax=docker/dockerfile:1

# debian-versions — probe which versions of a package install from a (custom)
# Debian apt repository. cli.mjs is the entrypoint: pass REPL commands as
# container args, or run with no args (and `-it`) for an interactive shell.
#
#   docker build -t debian-versions:lts-latest .
#
#   docker run --rm debian-versions:lts-latest versions bash
#   docker run --rm debian-versions:lts-latest test bash 5
#   docker run --rm debian-versions:lts-latest run bash --limit 5 --first-only -v
#   docker run --rm -it debian-versions:lts-latest                 # interactive REPL
#
# The tool builds a throwaway apt cache inside the container and downloads each
# version into it, so the container needs network access to your repository.
# Point it at a repository and capture the report via a mount:
#   docker run --rm -e APT_REPOSITORY=http://reg/debian \
#       -v "$PWD/out:/app/out" debian-versions:lts-latest \
#       run bash --repository http://reg/debian --output out/report.json -v
#
# node:22-slim is Debian-based, so the native `apt`/`apt-cache` CLIs the tool
# wraps are already present alongside Node — no extra toolchain install needed.

ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-slim

# apt version the tool expects (advisory; matches main.DEFAULT_APT_VERSION).
ARG APT_VERSION=2.6.1

# Unbuffered-ish stdout so verbose install streaming surfaces in real time
# through `docker run`/`docker logs`; force apt non-interactive in every child.
ENV NODE_ENV=production \
    DEBIAN_FRONTEND=noninteractive

WORKDIR /app

# Only the three runtime modules + manifest (tests/CI/sandboxes excluded via
# .dockerignore).
COPY package.json main.mjs sdk.mjs cli.mjs ./

# Run as a non-root user; /app stays writable for the throwaway test cache and
# the JSON report the tool writes to the working directory.
RUN useradd --create-home --uid 10001 app \
    && chown -R app:app /app
USER app

# Container args become a single REPL command line; no args -> interactive shell.
ENTRYPOINT ["node", "cli.mjs"]
CMD []
