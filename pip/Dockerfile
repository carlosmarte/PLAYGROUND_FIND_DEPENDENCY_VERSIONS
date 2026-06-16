# syntax=docker/dockerfile:1

# pip-versions — probe which versions of a package install from a (custom)
# registry. cli.py is the entrypoint: pass REPL commands as container args, or
# run with no args (and `-it`) for an interactive shell.
#
#   docker build -t pip-versions:lts-latest .
#
#   docker run --rm pip-versions:lts-latest versions numpy
#   docker run --rm pip-versions:lts-latest test numpy 5
#   docker run --rm pip-versions:lts-latest run numpy --limit 5 --first-only -v
#   docker run --rm -it pip-versions:lts-latest                 # interactive REPL
#
# The tool builds a throwaway venv inside the container and pip-installs each
# version into it, so the container needs network access to your registry.
# Point it at a registry and capture the report via a mount:
#   docker run --rm -e PIP_INDEX_URL=https://reg/simple \
#       -v "$PWD/out:/app/out" pip-versions:lts-latest \
#       run numpy --index-url https://reg/simple --output out/report.json -v

ARG PYTHON_VERSION=3.13
FROM python:${PYTHON_VERSION}-slim

# pip pinned to match main.DEFAULT_PIP_VERSION so discovery runs against a known pip.
ARG PIP_VERSION=26.1.1

# Unbuffered stdout so verbose install streaming surfaces in real time through
# `docker run`/`docker logs`; skip .pyc clutter in the image.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# Pin the image's pip (used by `pip index versions` during discovery).
RUN python -m pip install --no-cache-dir "pip==${PIP_VERSION}"

WORKDIR /app

# Only the three runtime modules (tests/CI/venvs excluded via .dockerignore).
COPY main.py sdk.py cli.py ./

# Run as a non-root user; /app stays writable for the throwaway test venv and
# the JSON report the tool writes to the working directory.
RUN useradd --create-home --uid 10001 app \
    && chown -R app:app /app
USER app

# Container args become a single REPL command line; no args -> interactive shell.
ENTRYPOINT ["python", "cli.py"]
CMD []
