# syntax=docker/dockerfile:1

# pip-versions — probe which versions of a package install from a (custom)
# registry. cli.mjs is the entrypoint: pass REPL commands as container args, or
# run with no args (and `-it`) for an interactive shell.
#
#   docker build -t pip-versions:lts-latest .
#
#   docker run --rm pip-versions:lts-latest versions numpy
#   docker run --rm pip-versions:lts-latest test numpy 5
#   docker run --rm pip-versions:lts-latest run numpy --limit 5 --first-only -v
#   docker run --rm -it pip-versions:lts-latest                 # interactive REPL
#
# The tool itself is Node.js but drives the `pip` CLI (via `python3 -m pip`): it
# builds a throwaway venv inside the container and pip-installs each version into
# it, so the container needs network access to your registry. Point it at a
# registry and capture the report via a mount:
#   docker run --rm -e PIP_INDEX_URL=https://reg/simple \
#       -v "$PWD/out:/app/out" pip-versions:lts-latest \
#       run numpy --index-url https://reg/simple --output out/report.json -v

ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-slim

# pip pinned to match main.DEFAULT_PIP_VERSION so discovery runs against a known pip.
ARG PIP_VERSION=26.1.1

# Unbuffered-ish stdout so verbose install streaming surfaces in real time
# through `docker run`/`docker logs`.
ENV NODE_ENV=production

# node:22-slim has no Python toolchain; install python3 + venv + pip (the CLI the
# Node tool shells out to) and pin the image's pip used during discovery.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv python3-pip \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m pip install --no-cache-dir --break-system-packages "pip==${PIP_VERSION}"

WORKDIR /app

# Only the three runtime modules + manifest (tests/CI/venvs excluded via
# .dockerignore).
COPY package.json main.mjs sdk.mjs cli.mjs ./

# Run as a non-root user; /app stays writable for the throwaway test venv and
# the JSON report the tool writes to the working directory.
RUN useradd --create-home --uid 10001 app \
    && chown -R app:app /app
USER app

# Container args become a single REPL command line; no args -> interactive shell.
ENTRYPOINT ["node", "cli.mjs"]
CMD []
