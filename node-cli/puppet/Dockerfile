# syntax=docker/dockerfile:1

# puppet-versions — probe which versions of a module install from a (custom)
# Puppet Forge. cli.mjs is the entrypoint: pass REPL commands as container args,
# or run with no args (and `-it`) for an interactive shell.
#
#   docker build -t puppet-versions:lts-latest .
#
#   docker run --rm puppet-versions:lts-latest versions puppetlabs-stdlib
#   docker run --rm puppet-versions:lts-latest test puppetlabs-stdlib 5
#   docker run --rm puppet-versions:lts-latest run puppetlabs-stdlib --limit 5 --first-only -v
#   docker run --rm -it puppet-versions:lts-latest             # interactive REPL
#
# The tool builds a throwaway target dir inside the container and `puppet module
# install`s each version into it, so the container needs network access to your
# Forge. Point it at a server and capture the report via a mount:
#   docker run --rm -e PUPPET_FORGE_SERVER=https://forgeapi.puppet.com \
#       -v "$PWD/out:/app/out" puppet-versions:lts-latest \
#       run puppetlabs-stdlib --forge-server https://forgeapi.puppet.com --output out/report.json -v

ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-slim

# puppet version this image targets, echoed to match main.DEFAULT_PUPPET_VERSION.
ARG PUPPET_VERSION=8.10.0

# Unbuffered-ish stdout so verbose install streaming surfaces in real time
# through `docker run`/`docker logs`.
ENV NODE_ENV=production

# NOTE: the tool shells out to the `puppet` binary for install-tests. The Forge
# discovery (`versions`) uses the v3 REST API over fetch() and needs no puppet,
# but `find`/`test` require `puppet` on PATH. puppet is NOT an npm package and is
# not present in node:22-slim — install the Puppet agent (or run install-tests in
# the puppet/puppet-agent image) if you need them. Discovery works as-is.

WORKDIR /app

# Only the three runtime modules + manifest (tests/CI/sandboxes excluded via
# .dockerignore).
COPY package.json main.mjs sdk.mjs cli.mjs ./

# Run as a non-root user; /app stays writable for the throwaway target dir and
# the JSON report the tool writes to the working directory.
RUN useradd --create-home --uid 10001 app \
    && chown -R app:app /app
USER app

# Container args become a single REPL command line; no args -> interactive shell.
ENTRYPOINT ["node", "cli.mjs"]
CMD []
