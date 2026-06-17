# syntax=docker/dockerfile:1

# gradle-versions — probe which versions of a dependency resolve from a (custom)
# Maven repository (via Gradle). cli.mjs is the entrypoint: pass REPL commands as
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

ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-slim

# gradle pinned to match main.DEFAULT_GRADLE_VERSION so discovery runs against a
# known gradle.
ARG GRADLE_VERSION=8.10

# Unbuffered-ish stdout so verbose resolve streaming surfaces in real time
# through `docker run`/`docker logs`.
ENV NODE_ENV=production

# The tool shells out to the `gradle` CLI (and gradle needs a JDK), NEITHER of
# which is present in node:22-slim. Install a JDK and the Gradle distribution so
# the build.gradle resolve probe works during tests. Discovery itself only needs
# the maven-metadata.xml over HTTP (Node's global fetch), but resolve-tests need
# gradle.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl unzip default-jdk-headless \
    && curl -fsSL "https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip" -o /tmp/gradle.zip \
    && unzip -q /tmp/gradle.zip -d /opt \
    && ln -s "/opt/gradle-${GRADLE_VERSION}/bin/gradle" /usr/local/bin/gradle \
    && rm /tmp/gradle.zip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Only the three runtime modules + manifest (tests/CI/sandboxes excluded via
# .dockerignore).
COPY package.json main.mjs sdk.mjs cli.mjs ./

# Run as a non-root user; /app stays writable for the throwaway Gradle sandbox
# and the JSON report the tool writes to the working directory.
RUN useradd --create-home --uid 10001 app \
    && chown -R app:app /app
USER app

# Container args become a single REPL command line; no args -> interactive shell.
ENTRYPOINT ["node", "cli.mjs"]
CMD []
