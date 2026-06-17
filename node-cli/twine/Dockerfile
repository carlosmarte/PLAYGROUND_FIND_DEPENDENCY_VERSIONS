# syntax=docker/dockerfile:1

# twine-versions — probe which versions of a package have valid distribution
# metadata (via `twine check`). cli.mjs is the entrypoint: pass REPL commands as
# container args, or run with no args (and `-it`) for an interactive shell.
#
# NOTE: twine is publish-side; this clone repurposes `twine check` as a
# metadata-validity probe — see main.mjs's module docstring.
#
#   docker build -t twine-versions:lts-latest .
#
#   docker run --rm twine-versions:lts-latest versions numpy
#   docker run --rm twine-versions:lts-latest test numpy 5
#   docker run --rm twine-versions:lts-latest run numpy --limit 5 --first-only -v
#   docker run --rm -it twine-versions:lts-latest                 # interactive REPL
#
# The tool downloads each version's distribution into a scratch dir inside the
# container and runs `twine check` on it, so the container needs network access
# to your registry. Point it at a registry and capture the report via a mount:
#   docker run --rm -e TWINE_REPOSITORY_URL=https://reg/simple \
#       -v "$PWD/out:/app/out" twine-versions:lts-latest \
#       run numpy --index-url https://reg/simple --output out/report.json -v

ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-slim

# twine pinned to match main.DEFAULT_TWINE_VERSION so checks run the known validators.
# The metadata-tests shell out to `python3 -m pip download` and `python3 -m twine
# check`, neither of which ships in node:22-slim, so we install Python 3, pip,
# and twine. Version discovery itself hits the PyPI JSON API over global fetch
# and needs no Python.
ARG TWINE_VERSION=5.1.1

# Unbuffered-ish stdout so verbose streaming surfaces in real time through
# `docker run`/`docker logs`.
ENV NODE_ENV=production \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# Install Python 3 + pip, then twine (used by `twine check` during metadata-tests).
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip ca-certificates \
    && python3 -m pip install --no-cache-dir --break-system-packages "twine==${TWINE_VERSION}" \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Only the runtime modules + manifest (tests/CI/sandboxes excluded via
# .dockerignore).
COPY package.json main.mjs sdk.mjs cli.mjs ./

# Run as a non-root user; /app stays writable for the scratch download dir and
# the JSON report the tool writes to the working directory.
RUN useradd --create-home --uid 10001 app \
    && chown -R app:app /app
USER app

# Container args become a single REPL command line; no args -> interactive shell.
ENTRYPOINT ["node", "cli.mjs"]
CMD []
