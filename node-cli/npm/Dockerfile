# syntax=docker/dockerfile:1

# npm-versions — probe which versions of a package install from a (custom)
# registry. cli.mjs is the entrypoint: pass REPL commands as container args, or
# run with no args (and `-it`) for an interactive shell.
#
#   docker build -t npm-versions:lts-latest .
#
#   docker run --rm npm-versions:lts-latest versions left-pad
#   docker run --rm npm-versions:lts-latest test left-pad 5
#   docker run --rm npm-versions:lts-latest run left-pad --limit 5 --first-only -v
#   docker run --rm -it npm-versions:lts-latest                 # interactive REPL
#
# The tool builds a throwaway install prefix inside the container and npm-installs
# each version into it, so the container needs network access to your registry.
# Point it at a registry and capture the report via a mount:
#   docker run --rm -e NPM_CONFIG_REGISTRY=https://reg \
#       -v "$PWD/out:/app/out" npm-versions:lts-latest \
#       run left-pad --registry https://reg --output out/report.json -v

ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-slim

# npm pinned to match main.DEFAULT_NPM_VERSION so discovery runs against a known npm.
ARG NPM_VERSION=10.9.2

# Unbuffered-ish stdout so verbose install streaming surfaces in real time
# through `docker run`/`docker logs`.
ENV NODE_ENV=production

# Pin the image's npm (used by `npm view` during discovery).
RUN npm install -g "npm@${NPM_VERSION}"

WORKDIR /app

# Only the three runtime modules + manifest (tests/CI/sandboxes excluded via
# .dockerignore).
COPY package.json main.mjs sdk.mjs cli.mjs ./

# Run as a non-root user; /app stays writable for the throwaway test prefix and
# the JSON report the tool writes to the working directory.
RUN useradd --create-home --uid 10001 app \
    && chown -R app:app /app
USER app

# Container args become a single REPL command line; no args -> interactive shell.
ENTRYPOINT ["node", "cli.mjs"]
CMD []
