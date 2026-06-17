# syntax=docker/dockerfile:1

# go-versions — probe which versions of a module fetch from a (custom) module
# proxy. cli.mjs is the entrypoint: pass REPL commands as container args, or run
# with no args (and `-it`) for an interactive shell.
#
#   docker build -t go-versions:lts-latest .
#
#   docker run --rm go-versions:lts-latest versions github.com/stretchr/testify
#   docker run --rm go-versions:lts-latest test github.com/stretchr/testify 5
#   docker run --rm go-versions:lts-latest run github.com/stretchr/testify --limit 5 --first-only -v
#   docker run --rm -it go-versions:lts-latest                 # interactive REPL
#
# The tool builds a throwaway module inside the container and go-fetches each
# version into it, so the container needs network access to your proxy.
# Point it at a proxy and capture the report via a mount:
#   docker run --rm -e GOPROXY=https://proxy \
#       -v "$PWD/out:/app/out" go-versions:lts-latest \
#       run github.com/stretchr/testify --proxy https://proxy --output out/report.json -v

ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-slim

# go toolchain version this image targets (matches main.DEFAULT_GO_VERSION).
ARG GO_VERSION=1.23.4

# Unbuffered-ish stdout so verbose fetch streaming surfaces in real time through
# `docker run`/`docker logs`.
ENV NODE_ENV=production

# The tool shells out to the `go` CLI, which is NOT present in node:22-slim.
# Install the Go toolchain so discovery (`go list`) and fetch (`go get`) work.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates wget \
    && ARCH="$(dpkg --print-architecture)" \
    && wget -q "https://go.dev/dl/go${GO_VERSION}.linux-${ARCH}.tar.gz" -O /tmp/go.tgz \
    && tar -C /usr/local -xzf /tmp/go.tgz \
    && rm /tmp/go.tgz \
    && rm -rf /var/lib/apt/lists/*
ENV PATH="/usr/local/go/bin:${PATH}"

WORKDIR /app

# Only the three runtime modules + manifest (tests/CI/sandboxes excluded via
# .dockerignore).
COPY package.json main.mjs sdk.mjs cli.mjs ./

# Run as a non-root user; /app stays writable for the throwaway test module and
# the JSON report the tool writes to the working directory. A writable GOPATH/
# cache home is needed for go fetches.
RUN useradd --create-home --uid 10001 app \
    && chown -R app:app /app
USER app
ENV GOPATH=/home/app/go \
    GOCACHE=/home/app/.cache/go-build

# Container args become a single REPL command line; no args -> interactive shell.
ENTRYPOINT ["node", "cli.mjs"]
CMD []
