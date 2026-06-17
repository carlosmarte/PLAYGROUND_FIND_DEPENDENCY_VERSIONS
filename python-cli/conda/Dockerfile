# syntax=docker/dockerfile:1

# conda-versions — probe which versions of a package install from a (custom)
# conda channel. cli.py is the entrypoint: pass REPL commands as container args,
# or run with no args (and `-it`) for an interactive shell.
#
#   docker build -t conda-versions:lts-latest .
#
#   docker run --rm conda-versions:lts-latest versions numpy
#   docker run --rm conda-versions:lts-latest test numpy 5
#   docker run --rm conda-versions:lts-latest run numpy --limit 5 --first-only -v
#   docker run --rm -it conda-versions:lts-latest                 # interactive REPL
#
# The tool creates a throwaway conda prefix inside the container and installs
# each version into it via `conda create --prefix`, so the container needs
# network access to your channel. Point it at a channel and capture the report
# via a mount:
#   docker run --rm -e CONDA_CHANNELS=conda-forge \
#       -v "$PWD/out:/app/out" conda-versions:lts-latest \
#       run numpy --channel conda-forge --output out/report.json -v

# miniconda3 ships conda + python; the tool runs on that same Python interpreter.
FROM continuumio/miniconda3:latest

# conda version the test environment expects (matches main.DEFAULT_CONDA_VERSION).
ARG CONDA_VERSION=24.9.2

# Unbuffered stdout so verbose install streaming surfaces in real time through
# `docker run`/`docker logs`; skip .pyc clutter in the image.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

# Only the three runtime modules (tests/CI/venvs excluded via .dockerignore).
COPY main.py sdk.py cli.py ./

# Run as a non-root user; /app stays writable for the throwaway test prefixes and
# the JSON report the tool writes to the working directory.
RUN useradd --create-home --uid 10001 app \
    && chown -R app:app /app
USER app

# Container args become a single REPL command line; no args -> interactive shell.
ENTRYPOINT ["python", "cli.py"]
CMD []
