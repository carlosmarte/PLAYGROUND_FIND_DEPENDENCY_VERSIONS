# syntax=docker/dockerfile:1

# apk-versions — probe which versions of a package install from a (custom)
# Alpine apk repository. cli.py is the entrypoint: pass REPL commands as
# container args, or run with no args (and `-it`) for an interactive shell.
#
#   docker build -t apk-versions:lts-latest .
#
#   docker run --rm apk-versions:lts-latest versions busybox
#   docker run --rm apk-versions:lts-latest test busybox 5
#   docker run --rm apk-versions:lts-latest run busybox --limit 5 --first-only -v
#   docker run --rm -it apk-versions:lts-latest                 # interactive REPL
#
# The tool builds a throwaway apk root inside the container and installs each
# version into it, so the container needs network access to your repository.
# Point it at a repository and capture the report via a mount:
#   docker run --rm -e APK_REPOSITORY=https://reg/main \
#       -v "$PWD/out:/app/out" apk-versions:lts-latest \
#       run busybox --repository https://reg/main --output out/report.json -v

# Alpine base so the native `apk` CLI (apk-tools) the tool wraps is present,
# and Python (python3) is installed for the wrapper itself.
FROM alpine:latest

# apk-tools version the tool expects (advisory; matches main.DEFAULT_APK_VERSION).
ARG APK_VERSION=2.14.4

# Unbuffered stdout so verbose install streaming surfaces in real time through
# `docker run`/`docker logs`; skip .pyc clutter in the image.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# Install Python 3 (the wrapper) alongside the apk-tools the image already ships.
RUN apk add --no-cache python3

WORKDIR /app

# Only the three runtime modules (tests/CI/venvs excluded via .dockerignore).
COPY main.py sdk.py cli.py ./

# Run as a non-root user; /app stays writable for the throwaway test root and
# the JSON report the tool writes to the working directory.
RUN adduser -D -u 10001 app \
    && chown -R app:app /app
USER app

# Container args become a single REPL command line; no args -> interactive shell.
ENTRYPOINT ["python3", "cli.py"]
CMD []
