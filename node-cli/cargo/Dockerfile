# syntax=docker/dockerfile:1

# cargo-versions — probe which versions of a crate fetch from a (custom)
# registry. cli.mjs is the entrypoint: pass REPL commands as container args, or
# run with no args (and `-it`) for an interactive shell.
#
#   docker build -t cargo-versions:lts-latest .
#
#   docker run --rm cargo-versions:lts-latest versions serde
#   docker run --rm cargo-versions:lts-latest test serde 5
#   docker run --rm cargo-versions:lts-latest run serde --limit 5 --first-only -v
#   docker run --rm -it cargo-versions:lts-latest               # interactive REPL
#
# The tool builds a throwaway crate inside the container and cargo-fetches each
# version into it, so the container needs network access to your registry.
# Point it at a registry and capture the report via a mount:
#   docker run --rm -e CARGO_REGISTRIES_CRATES_IO_INDEX=https://reg \
#       -v "$PWD/out:/app/out" cargo-versions:lts-latest \
#       run serde --registry https://reg --output out/report.json -v

# Node base runs the tool (a Node harness wrapping the cargo CLI). The HTTP
# version-listing works out of the box; the fetch-test step shells out to the
# `cargo` toolchain, which is NOT present in node:22-slim — install rustup/cargo
# below so install-tests work, otherwise the `versions` listing still runs fine.
ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-slim

# cargo/rust toolchain version this image targets (matches main.DEFAULT_CARGO_VERSION
# in spirit; the actual cargo is whatever rustup installs below).
ARG CARGO_VERSION=1.83.0

# Unbuffered-ish stdout so verbose fetch streaming surfaces in real time
# through `docker run`/`docker logs`.
ENV NODE_ENV=production

# Install the Rust toolchain (cargo) so the fetch-test step can run. The HTTP
# `versions` listing works regardless; only `find`/`test` need cargo on PATH.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates gcc \
    && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
        | sh -s -- -y --default-toolchain "${CARGO_VERSION}" --profile minimal \
    && rm -rf /var/lib/apt/lists/*
ENV PATH="/root/.cargo/bin:${PATH}"

WORKDIR /app

# Only the three runtime modules + manifest (tests/CI/sandboxes excluded via
# .dockerignore).
COPY package.json main.mjs sdk.mjs cli.mjs ./

# Run as a non-root user; /app stays writable for the throwaway test crate and
# the JSON report the tool writes to the working directory.
RUN useradd --create-home --uid 10001 app \
    && chown -R app:app /app
USER app

# Container args become a single REPL command line; no args -> interactive shell.
ENTRYPOINT ["node", "cli.mjs"]
CMD []
