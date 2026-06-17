# syntax=docker/dockerfile:1

# stack-versions — probe which versions of a package resolve from a (custom)
# Stackage/Hackage registry. cli.py is the entrypoint: pass REPL commands as
# container args, or run with no args (and `-it`) for an interactive shell.
#
#   docker build -t stack-versions:lts-latest .
#
#   docker run --rm stack-versions:lts-latest versions aeson
#   docker run --rm stack-versions:lts-latest test aeson 5
#   docker run --rm stack-versions:lts-latest run aeson --limit 5 --first-only -v
#   docker run --rm -it stack-versions:lts-latest                 # interactive REPL
#
# The tool builds a throwaway resolve sandbox inside the container — a per-version
# stack project pinning one `extra-dep` — and runs `stack build --dry-run`, so the
# container needs network access to your registry. Point it at a registry and
# capture the report via a mount:
#   docker run --rm -e STACK_RESOLVER=lts \
#       -v "$PWD/out:/app/out" stack-versions:lts-latest \
#       run aeson --index-url https://hackage.haskell.org --output out/report.json -v

# haskell slim ships GHC; we install stack into it below. Python3 comes from the
# base's Debian layer (installed explicitly to be safe), since the tool itself is
# Python + stdlib only and merely shells out to stack.
ARG HASKELL_VERSION=9.8
FROM haskell:${HASKELL_VERSION}-slim

# stack version the tool expects (matches main.DEFAULT_STACK_VERSION). Installed
# via the upstream script so resolve-tests run against a known stack.
ARG STACK_VERSION=3.1.1

# Unbuffered stdout so verbose resolve streaming surfaces in real time through
# `docker run`/`docker logs`; skip .pyc clutter in the image.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    STACK_RESOLVER=lts

# Python3 to run the tool; stack for the resolve-tests it shells out to.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 curl ca-certificates \
    && curl -sSL https://get.haskellstack.org/ | sh \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Only the three runtime modules (tests/CI/venvs excluded via .dockerignore).
COPY main.py sdk.py cli.py ./

# Run as a non-root user; /app stays writable for the throwaway resolve sandbox
# and the JSON report the tool writes to the working directory.
RUN useradd --create-home --uid 10001 app \
    && chown -R app:app /app
USER app

# Container args become a single REPL command line; no args -> interactive shell.
ENTRYPOINT ["python3", "cli.py"]
CMD []
