# syntax=docker/dockerfile:1

# helm-versions — probe which versions of a chart pull from a (custom) Helm
# repository. cli.py is the entrypoint: pass REPL commands as container args, or
# run with no args (and `-it`) for an interactive shell.
#
#   docker build -t helm-versions:lts-latest .
#
#   docker run --rm helm-versions:lts-latest versions bitnami/nginx
#   docker run --rm helm-versions:lts-latest test bitnami/nginx 5
#   docker run --rm helm-versions:lts-latest run bitnami/nginx --limit 5 --first-only -v
#   docker run --rm -it helm-versions:lts-latest               # interactive REPL
#
# The tool shells out to the `helm` CLI to search/pull each chart version, so
# the container needs network access to your chart repo. Point it at a repo and
# capture the report via a mount:
#   docker run --rm -e HELM_REPO_URL=https://charts.example.com \
#       -v "$PWD/out:/app/out" helm-versions:lts-latest \
#       run bitnami/nginx --repo-url https://charts.example.com --output out/report.json -v
#
# Base image `alpine/helm` ships the helm client on Alpine; we add Python 3 for
# the tool itself (alternatively use python:3.13-slim and install the helm CLI).

ARG HELM_CLI_VERSION=3.16.3
FROM alpine/helm:${HELM_CLI_VERSION}

# helm version main.py expects by default (soft check; warns on drift).
ARG HELM_VERSION=3.16.3

# Unbuffered stdout so verbose pull streaming surfaces in real time through
# `docker run`/`docker logs`; skip .pyc clutter in the image.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# Add Python 3 (the tool itself runs on Python; it wraps the helm CLI). Reset
# the entrypoint the base image sets to `helm` so cli.py drives instead.
RUN apk add --no-cache python3
ENTRYPOINT []

WORKDIR /app

# Only the three runtime modules (tests/CI/venvs excluded via .dockerignore).
COPY main.py sdk.py cli.py ./

# Run as a non-root user; /app stays writable for the chart-pull destination and
# the JSON report the tool writes to the working directory.
RUN adduser -D -u 10001 app \
    && chown -R app:app /app
USER app

# Container args become a single REPL command line; no args -> interactive shell.
ENTRYPOINT ["python3", "cli.py"]
CMD []
