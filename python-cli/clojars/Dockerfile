# syntax=docker/dockerfile:1

# clojars-versions — probe which versions of an artifact resolve from Clojars
# (or a Maven repo). cli.py is the entrypoint: pass REPL commands as container
# args, or run with no args (and `-it`) for an interactive shell.
#
#   docker build -t clojars-versions:lts-latest .
#
#   docker run --rm clojars-versions:lts-latest versions org.clojure:clojure
#   docker run --rm clojars-versions:lts-latest test org.clojure:clojure 5
#   docker run --rm clojars-versions:lts-latest run org.clojure:clojure --limit 5 --first-only -v
#   docker run --rm -it clojars-versions:lts-latest                 # interactive REPL
#
# The tool builds a throwaway local Maven repository inside the container and
# resolves each version into it via `mvn dependency:get`, so the container needs
# network access to Clojars. Point it at a repo and capture the report via a mount:
#   docker run --rm -e CLOJARS_REPO_URL=https://repo.clojars.org \
#       -v "$PWD/out:/app/out" clojars-versions:lts-latest \
#       run org.clojure:clojure --repo-url https://repo.clojars.org --output out/report.json -v

# Image ships the Clojure tools + a JDK; mvn/clojure drive the resolve probe.
FROM clojure:temurin-21-tools-deps

# clojure/lein pinned to match main.DEFAULT_CLOJURE_VERSION so discovery runs against a known toolchain.
ARG CLOJURE_VERSION=1.12.0

# Unbuffered stdout so verbose resolve streaming surfaces in real time through
# `docker run`/`docker logs`; skip .pyc clutter in the image.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# The tool driver is Python; the clojure base image ships a system python3.
WORKDIR /app

# Only the three runtime modules (tests/CI/venvs excluded via .dockerignore).
COPY main.py sdk.py cli.py ./

# Run as a non-root user; /app stays writable for the throwaway local Maven
# repo and the JSON report the tool writes to the working directory.
RUN useradd --create-home --uid 10001 app \
    && chown -R app:app /app
USER app

# Container args become a single REPL command line; no args -> interactive shell.
ENTRYPOINT ["python3", "cli.py"]
CMD []
