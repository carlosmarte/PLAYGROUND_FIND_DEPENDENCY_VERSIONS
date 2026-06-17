# syntax=docker/dockerfile:1

# cpan-versions — probe which versions of a distribution install from a (custom)
# CPAN mirror. cli.mjs is the entrypoint: pass REPL commands as container args, or
# run with no args (and `-it`) for an interactive shell.
#
#   docker build -t cpan-versions:lts-latest .
#
#   docker run --rm cpan-versions:lts-latest versions JSON
#   docker run --rm cpan-versions:lts-latest test JSON 5
#   docker run --rm cpan-versions:lts-latest run JSON --limit 5 --first-only -v
#   docker run --rm -it cpan-versions:lts-latest                 # interactive REPL
#
# The tool builds a throwaway local-lib sandbox inside the container and runs
# `cpanm --local-lib` for each version, so the container needs network access to
# your mirror. Point it at a mirror and capture the report via a mount:
#   docker run --rm -e PERL_CPANM_MIRROR=https://www.cpan.org \
#       -v "$PWD/out:/app/out" cpan-versions:lts-latest \
#       run JSON --index-url https://www.cpan.org --output out/report.json -v

ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-slim

# cpanm version the tool expects (matches main.DEFAULT_CPANM_VERSION). Installed
# via the Debian cpanminus package so install-tests run against a known cpanm.
ARG CPANM_VERSION=1.7047

# Unbuffered-ish stdout so verbose install streaming surfaces in real time
# through `docker run`/`docker logs`.
ENV NODE_ENV=production \
    PERL_CPANM_MIRROR=https://www.cpan.org

# node:22-slim ships neither Perl nor cpanm; the tool shells out to `cpanm` for
# install-tests, so install Perl + cpanminus here. (Discovery uses MetaCPAN over
# fetch(), which Node provides natively.)
RUN apt-get update \
    && apt-get install -y --no-install-recommends perl cpanminus ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Only the three runtime modules + manifest (tests/CI/sandboxes excluded via
# .dockerignore).
COPY package.json main.mjs sdk.mjs cli.mjs ./

# Run as a non-root user; /app stays writable for the throwaway local-lib
# sandbox and the JSON report the tool writes to the working directory.
RUN useradd --create-home --uid 10001 app \
    && chown -R app:app /app
USER app

# Container args become a single REPL command line; no args -> interactive shell.
ENTRYPOINT ["node", "cli.mjs"]
CMD []
