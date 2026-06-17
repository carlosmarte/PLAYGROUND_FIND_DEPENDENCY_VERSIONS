# syntax=docker/dockerfile:1

# vcpkg-versions — probe which versions of a port install from the (custom)
# vcpkg registry. cli.mjs is the entrypoint: pass REPL commands as container args,
# or run with no args (and `-it`) for an interactive shell.
#
#   docker build -t vcpkg-versions:lts-latest .
#
#   docker run --rm vcpkg-versions:lts-latest versions fmt
#   docker run --rm vcpkg-versions:lts-latest test fmt 5
#   docker run --rm vcpkg-versions:lts-latest run fmt --limit 5 --first-only -v
#   docker run --rm -it vcpkg-versions:lts-latest              # interactive REPL
#
# The tool shells out to the `vcpkg` CLI to install each version, so a real
# install-test needs a vcpkg checkout ($VCPKG_ROOT) plus a C/C++ toolchain
# (git, cmake, ninja, a compiler) — those are heavy, so this image ships only
# the Node tool and expects vcpkg + build tools to be mounted/installed at run
# time. `versions` (HTTP-only discovery via the versions DB, over fetch) works
# out of the box.
#
#   docker run --rm -e VCPKG_ROOT=/opt/vcpkg \
#       -v /opt/vcpkg:/opt/vcpkg -v "$PWD/out:/app/out" vcpkg-versions:lts-latest \
#       run fmt --output out/report.json -v
#
# Base image node:22-slim runs the tool itself; install vcpkg + build tools
# separately when you need the install-test step (not just `versions`).

ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-slim

# vcpkg version main.mjs expects by default (soft check; warns on drift).
ARG VCPKG_VERSION=2024-10-18

# Unbuffered-ish stdout so verbose install streaming surfaces in real time
# through `docker run`/`docker logs`.
ENV NODE_ENV=production

WORKDIR /app

# Only the runtime modules + manifest (tests/CI/sandboxes excluded via
# .dockerignore).
COPY package.json main.mjs sdk.mjs cli.mjs ./

# Run as a non-root user; /app stays writable for the throwaway install sandbox
# and the JSON report the tool writes to the working directory.
RUN useradd --create-home --uid 10001 app \
    && chown -R app:app /app
USER app

# Container args become a single REPL command line; no args -> interactive shell.
ENTRYPOINT ["node", "cli.mjs"]
CMD []
