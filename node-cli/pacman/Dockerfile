# syntax=docker/dockerfile:1

# pacman-versions — probe which versions of a package install from a (custom)
# Arch pacman repository / archive. cli.mjs is the entrypoint: pass REPL commands
# as container args, or run with no args (and `-it`) for an interactive shell.
#
#   docker build -t pacman-versions:lts-latest .
#
#   docker run --rm pacman-versions:lts-latest versions bash
#   docker run --rm pacman-versions:lts-latest test bash 5
#   docker run --rm pacman-versions:lts-latest run bash --limit 5 --first-only -v
#   docker run --rm -it pacman-versions:lts-latest              # interactive REPL
#
# The tool builds a throwaway pacman cache inside the container and downloads
# each version into it, so the container needs network access to your
# repository / the Arch archive. Capture the report via a mount:
#   docker run --rm -e PACMAN_REPOSITORY=https://archive.archlinux.org \
#       -v "$PWD/out:/app/out" pacman-versions:lts-latest \
#       run bash --repository https://archive.archlinux.org --output out/report.json -v

ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-slim

# pacman version the tool expects (advisory; matches main.DEFAULT_PACMAN_VERSION).
ARG PACMAN_VERSION=6.1.0

# Unbuffered-ish stdout so verbose install streaming surfaces in real time
# through `docker run`/`docker logs`.
ENV NODE_ENV=production

# IMPORTANT: this tool wraps the native `pacman` and `vercmp` CLIs, which are
# Arch-specific and NOT available on the Debian-based node:22-slim image (nor
# packaged for Debian). Version discovery degrades gracefully — the historical
# archive listing is fetched over HTTP and versions are sorted with a fallback
# string compare when `vercmp` is missing — but the actual download-tests
# (`pacman -Sw`) require a real pacman on PATH. To run the full install-test
# flow, either base this image on `archlinux:latest` (which ships pacman +
# vercmp + node via `pacman -Sy nodejs`) or mount/install pacman into this image.

WORKDIR /app

# Only the three runtime modules + manifest (tests/CI/sandboxes excluded via
# .dockerignore).
COPY package.json main.mjs sdk.mjs cli.mjs ./

# Run as a non-root user; /app stays writable for the throwaway test cache and
# the JSON report the tool writes to the working directory.
RUN useradd --create-home --uid 10001 app \
    && chown -R app:app /app
USER app

# Container args become a single REPL command line; no args -> interactive shell.
ENTRYPOINT ["node", "cli.mjs"]
CMD []
