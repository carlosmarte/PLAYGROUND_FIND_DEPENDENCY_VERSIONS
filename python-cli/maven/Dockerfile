# syntax=docker/dockerfile:1

# maven-versions — probe which versions of an artifact resolve from a (custom)
# Maven repository. cli.py is the entrypoint: pass REPL commands as container
# args, or run with no args (and `-it`) for an interactive shell.
#
#   docker build -t maven-versions:lts-latest .
#
#   docker run --rm maven-versions:lts-latest versions com.google.guava:guava
#   docker run --rm maven-versions:lts-latest test com.google.guava:guava 5
#   docker run --rm maven-versions:lts-latest run com.google.guava:guava --limit 5 --first-only -v
#   docker run --rm -it maven-versions:lts-latest                 # interactive REPL
#
# The tool builds a throwaway local Maven repository inside the container and
# resolves each version into it, so the container needs network access to your
# repository. Point it at a repo and capture the report via a mount:
#   docker run --rm -e MAVEN_REPO_URL=https://repo/maven2 \
#       -v "$PWD/out:/app/out" maven-versions:lts-latest \
#       run com.google.guava:guava --repo-url https://repo/maven2 --output out/report.json -v

# Image ships maven + a JDK so `mvn dependency:get` works during discovery/tests.
FROM maven:3-eclipse-temurin-21

# maven pinned to match main.DEFAULT_MAVEN_VERSION so discovery runs against a known maven.
ARG MAVEN_VERSION=3.9.9

# Unbuffered stdout so verbose resolve streaming surfaces in real time through
# `docker run`/`docker logs`; skip .pyc clutter in the image.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# The tool driver is Python; the maven base image ships a system python3.
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
