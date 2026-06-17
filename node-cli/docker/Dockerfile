# syntax=docker/dockerfile:1

# docker-versions — probe which tags of an image pull from a (custom) registry.
# cli.mjs is the entrypoint: pass REPL commands as container args, or run with no
# args (and `-it`) for an interactive shell.
#
#   docker build -t docker-versions:lts-latest .
#
#   docker run --rm docker-versions:lts-latest versions library/nginx
#   docker run --rm docker-versions:lts-latest test library/nginx 5
#   docker run --rm docker-versions:lts-latest run library/nginx --limit 5 --first-only -v
#   docker run --rm -it docker-versions:lts-latest              # interactive REPL
#
# The tool shells out to the `docker` CLI to pull each tag, so the container
# needs access to a Docker daemon (mount the host socket) and network access to
# your registry. Point it at a registry and capture the report via a mount:
#   docker run --rm -e DOCKER_REGISTRY=registry.example.com \
#       -v /var/run/docker.sock:/var/run/docker.sock \
#       -v "$PWD/out:/app/out" docker-versions:lts-latest \
#       run library/nginx --registry registry.example.com --output out/report.json -v
#
# NOTE: tag discovery uses the Docker Hub / registry v2 HTTP APIs (global fetch,
# Node 18+) and needs no toolchain. The pull-tests (`find`/`test`/`run`) shell
# out to the `docker` CLI, which is NOT present in node:22-slim. To exercise
# pull-tests in this image you must install the docker client (e.g.
# `apt-get install docker.io` or copy the static binary in) and mount a Docker
# daemon socket so `docker` is on PATH and can reach a daemon.

ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-slim

# docker client version main.mjs expects by default (soft check; warns on drift).
ARG DOCKER_VERSION=27.3.1

# Unbuffered-ish stdout so verbose pull streaming surfaces in real time through
# `docker run`/`docker logs`.
ENV NODE_ENV=production

WORKDIR /app

# Only the three runtime modules + manifest (tests/CI/sandboxes excluded via
# .dockerignore).
COPY package.json main.mjs sdk.mjs cli.mjs ./

# Run as a non-root user; /app stays writable for the sandbox dir and the JSON
# report the tool writes to the working directory.
RUN useradd --create-home --uid 10001 app \
    && chown -R app:app /app
USER app

# Container args become a single REPL command line; no args -> interactive shell.
ENTRYPOINT ["node", "cli.mjs"]
CMD []
