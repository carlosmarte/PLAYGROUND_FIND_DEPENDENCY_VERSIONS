# syntax=docker/dockerfile:1

# ansible-versions — probe which versions of a collection install from a (custom)
# Ansible Galaxy. cli.mjs is the entrypoint: pass REPL commands as container args,
# or run with no args (and `-it`) for an interactive shell.
#
#   docker build -t ansible-versions:lts-latest .
#
#   docker run --rm ansible-versions:lts-latest versions community.general
#   docker run --rm ansible-versions:lts-latest test community.general 5
#   docker run --rm ansible-versions:lts-latest run community.general --limit 5 --first-only -v
#   docker run --rm -it ansible-versions:lts-latest             # interactive REPL
#
# The tool builds a throwaway sandbox dir inside the container and installs each
# version into it, so the container needs network access to your Galaxy server.
# Point it at a server and capture the report via a mount:
#   docker run --rm -e ANSIBLE_GALAXY_SERVER=https://galaxy.example.com \
#       -v "$PWD/out:/app/out" ansible-versions:lts-latest \
#       run community.general --galaxy-server https://galaxy.example.com --output out/report.json -v

ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-slim

# ansible pinned to match main.DEFAULT_ANSIBLE_VERSION so discovery/install runs
# against a known ansible-galaxy.
ARG ANSIBLE_VERSION=11.1.0

# Unbuffered-ish stdout so verbose install streaming surfaces in real time
# through `docker run`/`docker logs`.
ENV NODE_ENV=production

# The tool shells out to `ansible-galaxy`, which node:22-slim does not ship.
# Install Python + pip and the pinned ansible so the install-tests can run.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && pip3 install --no-cache-dir --break-system-packages "ansible==${ANSIBLE_VERSION}"

WORKDIR /app

# Only the three runtime modules + manifest (tests/CI/sandboxes excluded via
# .dockerignore).
COPY package.json main.mjs sdk.mjs cli.mjs ./

# Run as a non-root user; /app stays writable for the throwaway test sandbox and
# the JSON report the tool writes to the working directory.
RUN useradd --create-home --uid 10001 app \
    && chown -R app:app /app
USER app

# Container args become a single REPL command line; no args -> interactive shell.
ENTRYPOINT ["node", "cli.mjs"]
CMD []
