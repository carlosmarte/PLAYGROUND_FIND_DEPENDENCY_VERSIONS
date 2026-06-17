# syntax=docker/dockerfile:1

# cargo-versions — probe which versions of a crate fetch from a (custom)
# registry. cli.py is the entrypoint: pass REPL commands as container args, or
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

# Slim Rust base ships cargo + the toolchain the tool tests against; we add
# Python (the tool itself is Python wrapping the cargo CLI).
ARG RUST_VERSION=1
FROM rust:${RUST_VERSION}-slim

# cargo/rust toolchain version this image targets (matches main.DEFAULT_CARGO_VERSION
# in spirit; the actual cargo is whatever the rust:1-slim tag provides).
ARG CARGO_VERSION=1.83.0

# Unbuffered stdout so verbose fetch streaming surfaces in real time through
# `docker run`/`docker logs`; skip .pyc clutter in the image.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# Install Python 3 (the tool runtime) alongside the Rust toolchain.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Only the three runtime modules (tests/CI/venvs excluded via .dockerignore).
COPY main.py sdk.py cli.py ./

# Run as a non-root user; /app stays writable for the throwaway test crate and
# the JSON report the tool writes to the working directory.
RUN useradd --create-home --uid 10001 app \
    && chown -R app:app /app
USER app

# Container args become a single REPL command line; no args -> interactive shell.
ENTRYPOINT ["python3", "cli.py"]
CMD []
