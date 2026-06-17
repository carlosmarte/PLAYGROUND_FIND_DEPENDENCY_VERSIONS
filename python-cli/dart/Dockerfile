# syntax=docker/dockerfile:1

# dart-versions — probe which versions of a package install from a (custom) pub
# server. cli.py is the entrypoint: pass REPL commands as container args, or run
# with no args (and `-it`) for an interactive shell.
#
#   docker build -t dart-versions:lts-latest .
#
#   docker run --rm dart-versions:lts-latest versions http
#   docker run --rm dart-versions:lts-latest test http 5
#   docker run --rm dart-versions:lts-latest run http --limit 5 --first-only -v
#   docker run --rm -it dart-versions:lts-latest                 # interactive REPL
#
# The tool builds a throwaway Dart package inside the container and runs
# `dart pub add` for each version into it, so the container needs network access
# to your pub server. Point it at a server and capture the report via a mount:
#   docker run --rm -e PUB_HOSTED_URL=https://pub.dev \
#       -v "$PWD/out:/app/out" dart-versions:lts-latest \
#       run http --hosted-url https://pub.dev --output out/report.json -v

# dart:stable ships the Dart SDK (dart + pub). We add Python to run the tool.
FROM dart:stable

# dart version the test package expects (matches main.DEFAULT_DART_VERSION).
ARG DART_VERSION=3.5.4

# Unbuffered stdout so verbose install streaming surfaces in real time through
# `docker run`/`docker logs`; skip .pyc clutter in the image.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# Python (to run the tool). dart:stable is Debian-based, so apt provides python3.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Only the three runtime modules (tests/CI/venvs excluded via .dockerignore).
COPY main.py sdk.py cli.py ./

# Run as a non-root user; /app stays writable for the throwaway test package and
# the JSON report the tool writes to the working directory.
RUN useradd --create-home --uid 10001 app \
    && chown -R app:app /app
USER app

# Container args become a single REPL command line; no args -> interactive shell.
ENTRYPOINT ["python3", "cli.py"]
CMD []
