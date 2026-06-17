# syntax=docker/dockerfile:1

# gradle-versions — probe which versions of a dependency resolve from a (custom)
# Maven repository (via Gradle). cli.py is the entrypoint: pass REPL commands as
# container args, or run with no args (and `-it`) for an interactive shell.
#
#   docker build -t gradle-versions:lts-latest .
#
#   docker run --rm gradle-versions:lts-latest versions com.google.guava:guava
#   docker run --rm gradle-versions:lts-latest test com.google.guava:guava 5
#   docker run --rm gradle-versions:lts-latest run com.google.guava:guava --limit 5 --first-only -v
#   docker run --rm -it gradle-versions:lts-latest                 # interactive REPL
#
# The tool builds a throwaway Gradle project inside the container and resolves
# each version into it, so the container needs network access to your
# repository. Point it at a repo and capture the report via a mount:
#   docker run --rm -e GRADLE_REPO_URL=https://repo/maven2 \
#       -v "$PWD/out:/app/out" gradle-versions:lts-latest \
#       run com.google.guava:guava --repo-url https://repo/maven2 --output out/report.json -v

# Image ships gradle + a JDK so the build.gradle resolve probe works during tests.
FROM gradle:8-jdk21

# gradle pinned to match main.DEFAULT_GRADLE_VERSION so discovery runs against a known gradle.
ARG GRADLE_VERSION=8.10

# Unbuffered stdout so verbose resolve streaming surfaces in real time through
# `docker run`/`docker logs`; skip .pyc clutter in the image.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# The tool driver is Python; the gradle base image ships a system python3.
WORKDIR /app

# Only the three runtime modules (tests/CI/venvs excluded via .dockerignore).
COPY main.py sdk.py cli.py ./

# Run as a non-root user; /app stays writable for the throwaway Gradle sandbox
# and the JSON report the tool writes to the working directory.
RUN useradd --create-home --uid 10001 app \
    && chown -R app:app /app
USER app

# Container args become a single REPL command line; no args -> interactive shell.
ENTRYPOINT ["python3", "cli.py"]
CMD []
