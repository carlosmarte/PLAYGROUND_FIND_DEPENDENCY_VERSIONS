# syntax=docker/dockerfile:1

# winget-versions — probe which versions of a package install from a winget
# source. cli.py is the entrypoint: pass REPL commands as container args, or
# run with no args (and `-it`) for an interactive shell.
#
# IMPORTANT: winget is Windows-only. This Linux python:slim image CANNOT run
# winget at all — neither listing (`winget show --versions`) nor install
# (`winget install`) will work, because the `winget` executable does not exist
# on Linux. This container is provided for parity/structure only; real use
# requires Windows with winget on PATH. The subprocess calls inside will fail
# here.
#
#   docker build -t winget-versions:lts-latest .
#
#   docker run --rm winget-versions:lts-latest versions Git.Git
#   docker run --rm winget-versions:lts-latest test Git.Git 5
#   docker run --rm winget-versions:lts-latest run Git.Git --limit 5 --first-only -v
#   docker run --rm -it winget-versions:lts-latest               # interactive REPL

# A slim Python base runs the (stdlib-only) Python harness. winget itself is
# absent on Linux — see the Windows-only note above.
ARG PYTHON_VERSION=3.13
FROM python:${PYTHON_VERSION}-slim

# Unbuffered stdout so verbose install streaming surfaces in real time through
# `docker run`/`docker logs`; skip .pyc clutter in the image.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# Pin pip for reproducible image builds (the tool wraps winget, not pip).
RUN python -m pip install --no-cache-dir "pip==26.1.1"

WORKDIR /app

# Only the three runtime modules (tests/CI/venvs excluded via .dockerignore).
COPY main.py sdk.py cli.py ./

# Run as a non-root user; /app stays writable for the throwaway test sandbox and
# the JSON report the tool writes to the working directory.
RUN useradd --create-home --uid 10001 app \
    && chown -R app:app /app
USER app

# Container args become a single REPL command line; no args -> interactive shell.
ENTRYPOINT ["python", "cli.py"]
CMD []
