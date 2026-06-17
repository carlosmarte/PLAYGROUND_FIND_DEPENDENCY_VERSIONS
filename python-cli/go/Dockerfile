# syntax=docker/dockerfile:1

# go-versions — probe which versions of a module fetch from a (custom) module
# proxy. cli.py is the entrypoint: pass REPL commands as container args, or run
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

# Bookworm-based Go base ships the go toolchain the tool tests against; we add
# Python (the tool itself is Python wrapping the go CLI).
ARG GOLANG_VERSION=1
FROM golang:${GOLANG_VERSION}-bookworm

# go toolchain version this image targets (matches main.DEFAULT_GO_VERSION in
# spirit; the actual go is whatever the golang:1-bookworm tag provides).
ARG GO_VERSION=1.23.4

# Unbuffered stdout so verbose fetch streaming surfaces in real time through
# `docker run`/`docker logs`; skip .pyc clutter in the image.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# Install Python 3 (the tool runtime) alongside the Go toolchain.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Only the three runtime modules (tests/CI/venvs excluded via .dockerignore).
COPY main.py sdk.py cli.py ./

# Run as a non-root user; /app stays writable for the throwaway test module and
# the JSON report the tool writes to the working directory. A writable GOPATH/
# cache home is needed for go fetches.
RUN useradd --create-home --uid 10001 app \
    && chown -R app:app /app
USER app
ENV GOPATH=/home/app/go \
    GOCACHE=/home/app/.cache/go-build

# Container args become a single REPL command line; no args -> interactive shell.
ENTRYPOINT ["python3", "cli.py"]
CMD []
