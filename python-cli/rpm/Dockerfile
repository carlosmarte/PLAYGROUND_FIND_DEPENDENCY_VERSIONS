# syntax=docker/dockerfile:1

# rpm-versions — probe which versions of a package install from a (custom)
# RPM/dnf repository. cli.py is the entrypoint: pass REPL commands as container
# args, or run with no args (and `-it`) for an interactive shell.
#
#   docker build -t rpm-versions:lts-latest .
#
#   docker run --rm rpm-versions:lts-latest versions bash
#   docker run --rm rpm-versions:lts-latest test bash 5
#   docker run --rm rpm-versions:lts-latest run bash --limit 5 --first-only -v
#   docker run --rm -it rpm-versions:lts-latest                 # interactive REPL
#
# The tool builds a throwaway download dir inside the container and downloads
# each version into it, so the container needs network access to your
# repository. Point it at a repo and capture the report via a mount:
#   docker run --rm -e DNF_REPOSITORY=fedora \
#       -v "$PWD/out:/app/out" rpm-versions:lts-latest \
#       run bash --repository fedora --output out/report.json -v

# Fedora base so the native `dnf` CLI the tool wraps is present, and Python
# (python3) is installed for the wrapper itself.
FROM fedora:latest

# dnf version the tool expects (advisory; matches main.DEFAULT_DNF_VERSION).
ARG DNF_VERSION=4.21.1

# Unbuffered stdout so verbose install streaming surfaces in real time through
# `docker run`/`docker logs`; skip .pyc clutter in the image.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# Install Python 3 (the wrapper) alongside the dnf the image already ships.
RUN dnf install -y python3 \
    && dnf clean all

WORKDIR /app

# Only the three runtime modules (tests/CI/venvs excluded via .dockerignore).
COPY main.py sdk.py cli.py ./

# Run as a non-root user; /app stays writable for the throwaway download dir and
# the JSON report the tool writes to the working directory.
RUN useradd --create-home --uid 10001 app \
    && chown -R app:app /app
USER app

# Container args become a single REPL command line; no args -> interactive shell.
ENTRYPOINT ["python3", "cli.py"]
CMD []
