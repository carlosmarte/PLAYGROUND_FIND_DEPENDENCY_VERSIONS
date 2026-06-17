# syntax=docker/dockerfile:1

# hex-versions — probe which versions of a package fetch from a (custom) Hex
# registry. cli.py is the entrypoint: pass REPL commands as container args, or
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

# Elixir slim ships mix; we install hex into it below. Python3 comes from the
# base's Debian layer (installed explicitly to be safe), since the tool itself
# is Python + stdlib only and merely shells out to mix.
ARG ELIXIR_VERSION=1.16
FROM elixir:${ELIXIR_VERSION}-slim

# hex version the tool expects (matches main.DEFAULT_HEX_VERSION). Installed via
# `mix local.hex` so discovery/fetch run against a known hex.
ARG HEX_VERSION=2.1.1

# Unbuffered stdout so verbose fetch streaming surfaces in real time through
# `docker run`/`docker logs`; skip .pyc clutter in the image.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HEX_MIRROR=https://repo.hex.pm

# Python3 to run the tool; mix/hex+rebar for the fetch-tests it shells out to.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mix local.hex --force \
    && mix local.rebar --force

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
