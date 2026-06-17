# syntax=docker/dockerfile:1

# conda-versions — probe which versions of a package install from a (custom)
# conda channel. cli.mjs is the entrypoint: pass REPL commands as container args,
# or run with no args (and `-it`) for an interactive shell.
#
#   docker build -t conda-versions:lts-latest .
#
#   docker run --rm conda-versions:lts-latest versions numpy
#   docker run --rm conda-versions:lts-latest test numpy 5
#   docker run --rm conda-versions:lts-latest run numpy --limit 5 --first-only -v
#   docker run --rm -it conda-versions:lts-latest                 # interactive REPL
#
# The tool creates a throwaway conda prefix inside the container and installs
# each version into it via `conda create --prefix`, so the container needs
# network access to your channel. Point it at a channel and capture the report
# via a mount:
#   docker run --rm -e CONDA_CHANNELS=conda-forge \
#       -v "$PWD/out:/app/out" conda-versions:lts-latest \
#       run numpy --channel conda-forge --output out/report.json -v

ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-slim

# conda version the test environment expects (matches main.DEFAULT_CONDA_VERSION).
ARG CONDA_VERSION=24.9.2

# Unbuffered-ish stdout so verbose install streaming surfaces in real time
# through `docker run`/`docker logs`.
ENV NODE_ENV=production \
    PATH=/opt/conda/bin:$PATH

# node:22-slim has no conda; the tool shells out to `conda search` / `conda
# create`, so install Miniconda (provides the `conda` binary on PATH). If you
# prefer to supply conda another way, drop this block and ensure `conda` is on
# PATH in the final image instead.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && curl -fsSL https://repo.anaconda.com/miniconda/Miniconda3-latest-Linux-x86_64.sh -o /tmp/miniconda.sh \
    && bash /tmp/miniconda.sh -b -p /opt/conda \
    && rm -f /tmp/miniconda.sh \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Only the three runtime modules + manifest (tests/CI/sandboxes excluded via
# .dockerignore).
COPY package.json main.mjs sdk.mjs cli.mjs ./

# Run as a non-root user; /app stays writable for the throwaway test prefixes and
# the JSON report the tool writes to the working directory.
RUN useradd --create-home --uid 10001 app \
    && chown -R app:app /app
USER app

# Container args become a single REPL command line; no args -> interactive shell.
ENTRYPOINT ["node", "cli.mjs"]
CMD []
