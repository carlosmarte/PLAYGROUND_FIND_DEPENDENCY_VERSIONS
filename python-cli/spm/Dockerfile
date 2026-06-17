# syntax=docker/dockerfile:1

# spm-versions — probe which versions (semver git tags) of a Swift package
# resolve. cli.py is the entrypoint: pass REPL commands as container args, or run
# with no args (and `-it`) for an interactive shell.
#
#   docker build -t spm-versions:lts-latest .
#
#   docker run --rm spm-versions:lts-latest versions https://github.com/apple/swift-argument-parser.git
#   docker run --rm spm-versions:lts-latest test https://github.com/apple/swift-argument-parser.git 5
#   docker run --rm spm-versions:lts-latest run https://github.com/apple/swift-argument-parser.git --limit 5 --first-only -v
#   docker run --rm -it spm-versions:lts-latest                # interactive REPL
#
# The tool builds a throwaway Swift package inside the container and runs
# `swift package resolve` against each pinned version, so the container needs
# network access to the package's git repo. Capture the report via a mount:
#   docker run --rm -v "$PWD/out:/app/out" spm-versions:lts-latest \
#       run https://github.com/apple/swift-argument-parser.git --output out/report.json -v

# Slim Swift base ships the swift toolchain (and git) the tool tests against;
# Python (the tool runtime) is added below.
ARG SWIFT_VERSION=slim
FROM swift:${SWIFT_VERSION}

# swift toolchain version this image targets (matches main.DEFAULT_SWIFT_VERSION
# in spirit; the actual swift is whatever the swift:slim tag provides).
ARG SWIFT_TOOLCHAIN_VERSION=6.0.3

# Unbuffered stdout so verbose resolve streaming surfaces in real time through
# `docker run`/`docker logs`; skip .pyc clutter in the image.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# Install Python 3 (the tool runtime) alongside the Swift toolchain.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 git ca-certificates \
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
