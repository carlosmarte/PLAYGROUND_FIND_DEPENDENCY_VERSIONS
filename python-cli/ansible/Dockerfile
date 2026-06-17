# syntax=docker/dockerfile:1

# ansible-versions — probe which versions of a collection install from a (custom)
# Ansible Galaxy. cli.py is the entrypoint: pass REPL commands as container args,
# or run with no args (and `-it`) for an interactive shell.
#
#   docker build -t ansible-versions:lts-latest .
#
#   docker run --rm ansible-versions:lts-latest versions community.general
#   docker run --rm ansible-versions:lts-latest test community.general 5
#   docker run --rm ansible-versions:lts-latest run community.general --limit 5 --first-only -v
#   docker run --rm -it ansible-versions:lts-latest             # interactive REPL
#
# The tool builds a throwaway sandbox dir inside the container and installs each
# version into it, so the container needs network access to your Galaxy server.
# Point it at a server and capture the report via a mount:
#   docker run --rm -e ANSIBLE_GALAXY_SERVER=https://galaxy.example.com \
#       -v "$PWD/out:/app/out" ansible-versions:lts-latest \
#       run community.general --galaxy-server https://galaxy.example.com --output out/report.json -v

ARG PYTHON_VERSION=3.13
FROM python:${PYTHON_VERSION}-slim

# ansible pinned to match main.DEFAULT_ANSIBLE_VERSION so discovery runs against
# a known ansible-galaxy.
ARG ANSIBLE_VERSION=11.1.0

# Unbuffered stdout so verbose install streaming surfaces in real time through
# `docker run`/`docker logs`; skip .pyc clutter in the image.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# Pin the image's ansible (provides ansible-galaxy, used during discovery/install).
RUN python -m pip install --no-cache-dir "ansible==${ANSIBLE_VERSION}"

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
