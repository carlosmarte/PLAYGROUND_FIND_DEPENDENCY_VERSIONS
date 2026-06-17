# syntax=docker/dockerfile:1

# docker-versions — probe which tags of an image pull from a (custom) registry.
# cli.py is the entrypoint: pass REPL commands as container args, or run with no
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
# Base image `docker:cli` ships the docker client on Alpine; we add Python 3 for
# the tool itself (alternatively use python:3.13-slim and install the docker CLI).

ARG DOCKER_CLI_VERSION=27.3.1
FROM docker:${DOCKER_CLI_VERSION}-cli

# docker client version main.py expects by default (soft check; warns on drift).
ARG DOCKER_VERSION=27.3.1

# Unbuffered stdout so verbose pull streaming surfaces in real time through
# `docker run`/`docker logs`; skip .pyc clutter in the image.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# Add Python 3 (the tool itself runs on Python; it wraps the docker CLI).
RUN apk add --no-cache python3

WORKDIR /app

# Only the three runtime modules (tests/CI/venvs excluded via .dockerignore).
COPY main.py sdk.py cli.py ./

# Run as a non-root user; /app stays writable for the sandbox dir and the JSON
# report the tool writes to the working directory.
RUN adduser -D -u 10001 app \
    && chown -R app:app /app
USER app

# Container args become a single REPL command line; no args -> interactive shell.
ENTRYPOINT ["python3", "cli.py"]
CMD []
