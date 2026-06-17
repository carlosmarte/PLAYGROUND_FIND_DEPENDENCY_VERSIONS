# syntax=docker/dockerfile:1

# hex-versions — probe which versions of a package fetch from a (custom) Hex
# registry. cli.mjs is the entrypoint: pass REPL commands as container args, or
# run with no args (and `-it`) for an interactive shell.
#
#   docker build -t hex-versions:lts-latest .
#
#   docker run --rm hex-versions:lts-latest versions jason
#   docker run --rm hex-versions:lts-latest test jason 5
#   docker run --rm hex-versions:lts-latest run jason --limit 5 --first-only -v
#   docker run --rm -it hex-versions:lts-latest                 # interactive REPL
#
# The tool builds a throwaway fetch sandbox inside the container and runs
# `mix hex.package fetch` for each version, so the container needs network
# access to your registry. Point it at a registry and capture the report via a
# mount:
#   docker run --rm -e HEX_MIRROR=https://repo.hex.pm \
#       -v "$PWD/out:/app/out" hex-versions:lts-latest \
#       run jason --index-url https://hex.pm --output out/report.json -v

ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-slim

# hex version the tool expects (matches main.DEFAULT_HEX_VERSION). Installed via
# `mix local.hex` so discovery/fetch run against a known hex.
ARG HEX_VERSION=2.1.1

# Unbuffered-ish stdout so verbose fetch streaming surfaces in real time through
# `docker run`/`docker logs`. Keep fetches hitting the configured mirror.
ENV NODE_ENV=production \
    HEX_MIRROR=https://repo.hex.pm

# Node runs the tool itself; the discovery is HTTP-only (global fetch), but the
# fetch-tests shell out to mix/hex+rebar. Install Elixir (which ships mix) from
# Debian, then bootstrap hex/rebar. NOTE: if `elixir` is unavailable in your
# base distro, the mix/hex toolchain must be provided some other way for real
# fetch-tests; discovery (the `versions` command) works without it.
RUN apt-get update \
    && apt-get install -y --no-install-recommends elixir ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mix local.hex --force \
    && mix local.rebar --force

WORKDIR /app

# Only the runtime modules + manifest (tests/CI/sandboxes excluded via
# .dockerignore).
COPY package.json main.mjs sdk.mjs cli.mjs ./

# Run as a non-root user; /app stays writable for the throwaway fetch sandbox
# and the JSON report the tool writes to the working directory.
RUN useradd --create-home --uid 10001 app \
    && chown -R app:app /app
USER app

# Container args become a single REPL command line; no args -> interactive shell.
ENTRYPOINT ["node", "cli.mjs"]
CMD []
