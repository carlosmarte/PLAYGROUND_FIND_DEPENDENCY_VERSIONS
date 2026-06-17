# syntax=docker/dockerfile:1

# cabal-versions — probe which versions of a package fetch from a (custom)
# Hackage registry. cli.py is the entrypoint: pass REPL commands as container
# args, or run with no args (and `-it`) for an interactive shell.
#
#   docker build -t cabal-versions:lts-latest .
#
#   docker run --rm cabal-versions:lts-latest versions aeson
#   docker run --rm cabal-versions:lts-latest test aeson 5
#   docker run --rm cabal-versions:lts-latest run aeson --limit 5 --first-only -v
#   docker run --rm -it cabal-versions:lts-latest                 # interactive REPL
#
# The tool builds a throwaway fetch sandbox inside the container and runs
# `cabal get` for each version, so the container needs network access to your
# registry. Point it at a registry and capture the report via a mount:
#   docker run --rm -e CABAL_REMOTE_REPO=https://hackage.haskell.org \
#       -v "$PWD/out:/app/out" cabal-versions:lts-latest \
#       run aeson --index-url https://hackage.haskell.org --output out/report.json -v

# haskell slim ships cabal + GHC. Python3 comes from the base's Debian layer
# (installed explicitly to be safe), since the tool itself is Python + stdlib
# only and merely shells out to cabal.
ARG HASKELL_VERSION=9.8
FROM haskell:${HASKELL_VERSION}-slim

# cabal version the tool expects (matches main.DEFAULT_CABAL_VERSION). The base
# image ships a cabal; we update its package index so fetch-tests resolve.
ARG CABAL_VERSION=3.12.1.0

# Unbuffered stdout so verbose fetch streaming surfaces in real time through
# `docker run`/`docker logs`; skip .pyc clutter in the image.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    CABAL_REMOTE_REPO=https://hackage.haskell.org

# Python3 to run the tool; refresh the cabal package index for the fetch-tests.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && cabal update

WORKDIR /app

# Only the three runtime modules (tests/CI/venvs excluded via .dockerignore).
COPY main.py sdk.py cli.py ./

# Run as a non-root user; /app stays writable for the throwaway fetch sandbox
# and the JSON report the tool writes to the working directory.
RUN useradd --create-home --uid 10001 app \
    && chown -R app:app /app
USER app

# Container args become a single REPL command line; no args -> interactive shell.
ENTRYPOINT ["python3", "cli.py"]
CMD []
