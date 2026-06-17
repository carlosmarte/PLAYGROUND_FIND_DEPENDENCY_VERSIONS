# syntax=docker/dockerfile:1

# apt-versions — probe which versions of a package install from a (custom)
# Debian apt repository. cli.py is the entrypoint: pass REPL commands as
# container args, or run with no args (and `-it`) for an interactive shell.
#
#   docker build -t apt-versions:lts-latest .
#
#   docker run --rm apt-versions:lts-latest versions bash
#   docker run --rm apt-versions:lts-latest test bash 5
#   docker run --rm apt-versions:lts-latest run bash --limit 5 --first-only -v
#   docker run --rm -it apt-versions:lts-latest                 # interactive REPL
#
# The tool builds a throwaway apt cache inside the container and downloads each
# version into it, so the container needs network access to your repository.
# Point it at a repository and capture the report via a mount:
#   docker run --rm -e APT_REPOSITORY=http://reg/debian \
#       -v "$PWD/out:/app/out" apt-versions:lts-latest \
#       run bash --repository http://reg/debian --output out/report.json -v

# Debian slim base so the native `apt` CLI the tool wraps is present, and Python
# (python3) is installed for the wrapper itself.
FROM debian:stable-slim

# apt version the tool expects (advisory; matches main.DEFAULT_APT_VERSION).
ARG APT_VERSION=2.6.1

# Unbuffered stdout so verbose install streaming surfaces in real time through
# `docker run`/`docker logs`; skip .pyc clutter in the image.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    DEBIAN_FRONTEND=noninteractive

# Install Python 3 (the wrapper) alongside the apt the image already ships.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Only the three runtime modules (tests/CI/venvs excluded via .dockerignore).
COPY main.py sdk.py cli.py ./

# Run as a non-root user; /app stays writable for the throwaway test cache and
# the JSON report the tool writes to the working directory.
RUN useradd --create-home --uid 10001 app \
    && chown -R app:app /app
USER app

# Container args become a single REPL command line; no args -> interactive shell.
ENTRYPOINT ["python3", "cli.py"]
CMD []
