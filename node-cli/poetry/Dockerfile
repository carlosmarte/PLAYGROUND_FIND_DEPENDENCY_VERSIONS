# syntax=docker/dockerfile:1

# poetry-versions — probe which versions of a package install from a (custom)
# Poetry source. cli.mjs is the entrypoint: pass REPL commands as container
# args, or run with no args (and `-it`) for an interactive shell.
#
#   docker build -t poetry-versions:lts-latest .
#
#   docker run --rm poetry-versions:lts-latest versions numpy
#   docker run --rm poetry-versions:lts-latest test numpy 5
#   docker run --rm poetry-versions:lts-latest run numpy --limit 5 --first-only -v
#   docker run --rm -it poetry-versions:lts-latest                 # interactive REPL
#
# The tool itself is Node.js but drives the `poetry` CLI: it builds a throwaway
# Poetry project inside the container and `poetry add`s each version into it, so
# the container needs network access to your registry. Version discovery hits the
# PyPI JSON API over the global fetch and needs no poetry. Point it at a registry
# and capture the report via a mount:
#   docker run --rm -e POETRY_REPOSITORIES_PYPI_URL=https://reg/simple \
#       -v "$PWD/out:/app/out" poetry-versions:lts-latest \
#       run numpy --index-url https://reg/simple --output out/report.json -v

FROM node:22-slim

# poetry pinned to match main.DEFAULT_POETRY_VERSION so install-tests run against a known poetry.
ARG POETRY_VERSION=1.8.3

# Unbuffered-ish stdout so verbose install streaming surfaces in real time
# through `docker run`/`docker logs`.
ENV NODE_ENV=production

# node:22-slim has no Python toolchain; install python3 + pip and use it to
# install the `poetry` CLI the Node tool shells out to during install-tests.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv python3-pip \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m pip install --no-cache-dir --break-system-packages "poetry==${POETRY_VERSION}"

WORKDIR /app

# Only the three runtime modules + manifest (tests/CI/projects excluded via
# .dockerignore).
COPY package.json main.mjs sdk.mjs cli.mjs ./

# Run as a non-root user; /app stays writable for the throwaway test project and
# the JSON report the tool writes to the working directory.
RUN useradd --create-home --uid 10001 app \
    && chown -R app:app /app
USER app

# Container args become a single REPL command line; no args -> interactive shell.
ENTRYPOINT ["node", "cli.mjs"]
CMD []
