# syntax=docker/dockerfile:1

# choco-versions — probe which versions of a package install from a (custom)
# Chocolatey registry. cli.py is the entrypoint: pass REPL commands as container
# args, or run with no args (and `-it`) for an interactive shell.
#
# IMPORTANT — platform note: `choco` is **Windows-only**, so the actual
# install-test step (`choco install`) is NOT possible inside this Linux slim
# image. This container still works for the HTTP version-listing — the
# `versions` command queries the Chocolatey community feed over HTTP and runs
# fine cross-platform. To run the install-test step you must be on Windows with
# `choco` on PATH.
#
#   docker build -t choco-versions:lts-latest .
#
#   docker run --rm choco-versions:lts-latest versions git    # works (HTTP listing)
#   docker run --rm choco-versions:lts-latest test git 5      # needs Windows + choco
#   docker run --rm choco-versions:lts-latest run git --limit 5 --first-only -v
#   docker run --rm -it choco-versions:lts-latest             # interactive REPL
#
# Point it at a registry and capture the report via a mount:
#   docker run --rm -e CHOCO_SOURCE=https://reg/api/v2/ \
#       -v "$PWD/out:/app/out" choco-versions:lts-latest \
#       run git --source https://reg/api/v2/ --output out/report.json -v

# Slim Python base — the (stdlib-only) Python harness drives the tool. The
# install-test step would additionally require choco (Windows-only), which this
# Linux image cannot provide; the HTTP `versions` listing works regardless.
ARG PYTHON_VERSION=3.13
FROM python:${PYTHON_VERSION}-slim

# Unbuffered stdout so verbose install streaming surfaces in real time through
# `docker run`/`docker logs`; skip .pyc clutter in the image.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# Pin pip in the image for reproducible builds (the tool itself wraps choco).
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
