# syntax=docker/dockerfile:1

# nuget-versions — probe which versions of a package install from a (custom)
# NuGet registry. cli.py is the entrypoint: pass REPL commands as container
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

# The .NET SDK image already ships dotnet + nuget AND a Python 3 interpreter is
# installed below so the (stdlib-only) Python harness can drive them.
ARG DOTNET_VERSION=8.0
FROM mcr.microsoft.com/dotnet/sdk:${DOTNET_VERSION}

# Unbuffered stdout so verbose install streaming surfaces in real time through
# `docker run`/`docker logs`; skip .pyc clutter in the image.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1

# The Python harness is stdlib-only; install a system python3 to run cli.py.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Only the three runtime modules (tests/CI/venvs excluded via .dockerignore).
COPY main.py sdk.py cli.py ./

# Run as a non-root user; /app stays writable for the throwaway test project and
# the JSON report the tool writes to the working directory.
RUN useradd --create-home --uid 10001 app \
    && chown -R app:app /app
USER app

# Container args become a single REPL command line; no args -> interactive shell.
ENTRYPOINT ["python3", "cli.py"]
CMD []
