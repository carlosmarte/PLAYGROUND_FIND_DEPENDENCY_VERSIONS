# syntax=docker/dockerfile:1

# vagrant-versions — probe which versions of a box install from a (custom)
# Vagrant Cloud. cli.mjs is the entrypoint: pass REPL commands as container args,
# or run with no args (and `-it`) for an interactive shell.
#
#   docker build -t vagrant-versions:lts-latest .
#
#   docker run --rm vagrant-versions:lts-latest versions hashicorp/bionic64
#   docker run --rm vagrant-versions:lts-latest test hashicorp/bionic64 5
#   docker run --rm vagrant-versions:lts-latest run hashicorp/bionic64 --limit 5 --first-only -v
#   docker run --rm -it vagrant-versions:lts-latest            # interactive REPL
#
# The tool builds a throwaway VAGRANT_HOME inside the container and `vagrant box
# add`s each version into it, so the container needs network access to your
# Vagrant Cloud. Point it at a server and capture the report via a mount:
#   docker run --rm -e VAGRANT_SERVER_URL=https://app.vagrantup.com \
#       -v "$PWD/out:/app/out" vagrant-versions:lts-latest \
#       run hashicorp/bionic64 --vagrant-server https://app.vagrantup.com --output out/report.json -v

# node:22-slim runs the (dependency-free) Node harness. `versions` works out of
# the box (HTTP discovery over fetch against the Vagrant Cloud REST API). The
# install-test step (`find`/`test`) shells out to the `vagrant` binary, which is
# NOT a pip/npm package and is absent from this image — mount/install it (and a
# provider such as VirtualBox) at run time, or the box-add subprocess will fail.
ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-slim

# vagrant version this image targets, echoed to match main.DEFAULT_VAGRANT_VERSION.
ARG VAGRANT_VERSION=2.4.1

# Unbuffered-ish stdout so verbose install streaming surfaces in real time
# through `docker run`/`docker logs`.
ENV NODE_ENV=production

WORKDIR /app

# Only the runtime modules + manifest (tests/CI/sandboxes excluded via
# .dockerignore).
COPY package.json main.mjs sdk.mjs cli.mjs ./

# Run as a non-root user; /app stays writable for the throwaway VAGRANT_HOME and
# the JSON report the tool writes to the working directory.
RUN useradd --create-home --uid 10001 app \
    && chown -R app:app /app
USER app

# Container args become a single REPL command line; no args -> interactive shell.
ENTRYPOINT ["node", "cli.mjs"]
CMD []
