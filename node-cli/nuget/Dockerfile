# syntax=docker/dockerfile:1

# nuget-versions — probe which versions of a package install from a (custom)
# NuGet registry. cli.mjs is the entrypoint: pass REPL commands as container
# args, or run with no args (and `-it`) for an interactive shell.
#
#   docker build -t nuget-versions:lts-latest .
#
#   docker run --rm nuget-versions:lts-latest versions Newtonsoft.Json
#   docker run --rm nuget-versions:lts-latest test Newtonsoft.Json 5
#   docker run --rm nuget-versions:lts-latest run Newtonsoft.Json --limit 5 --first-only -v
#   docker run --rm -it nuget-versions:lts-latest                 # interactive REPL
#
# The tool builds a throwaway .NET project inside the container and
# `dotnet add package`s each version into it, so the container needs network
# access to your registry. Point it at a registry and capture the report via a
# mount:
#   docker run --rm -e NUGET_SOURCE=https://reg/v3/index.json \
#       -v "$PWD/out:/app/out" nuget-versions:lts-latest \
#       run Newtonsoft.Json --source https://reg/v3/index.json --output out/report.json -v

ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-slim

# dotnet SDK version main.mjs defaults to, so discovery runs against a known SDK.
ARG DOTNET_VERSION=8.0

# Unbuffered-ish stdout so verbose install streaming surfaces in real time
# through `docker run`/`docker logs`; opt out of dotnet telemetry/first-run.
ENV NODE_ENV=production \
    DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1 \
    DOTNET_ROOT=/usr/share/dotnet \
    PATH=/usr/share/dotnet:$PATH

# The Node harness drives `dotnet add package` / `dotnet new`, which the
# node:22-slim base lacks. Install the .NET SDK via the official install script.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl libicu-dev \
    && curl -sSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh \
    && bash /tmp/dotnet-install.sh --channel "${DOTNET_VERSION}" --install-dir /usr/share/dotnet \
    && rm -f /tmp/dotnet-install.sh \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Only the three runtime modules + manifest (tests/CI/sandboxes excluded via
# .dockerignore).
COPY package.json main.mjs sdk.mjs cli.mjs ./

# Run as a non-root user; /app stays writable for the throwaway test project and
# the JSON report the tool writes to the working directory.
RUN useradd --create-home --uid 10001 app \
    && chown -R app:app /app
USER app

# Container args become a single REPL command line; no args -> interactive shell.
ENTRYPOINT ["node", "cli.mjs"]
CMD []
