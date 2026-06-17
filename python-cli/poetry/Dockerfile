# syntax=docker/dockerfile:1

# poetry-versions — probe which versions of a package install from a (custom)
# Poetry source. cli.py is the entrypoint: pass REPL commands as container args,
# or run with no args (and `-it`) for an interactive shell.
#
#   docker build -t poetry-versions:lts-latest .
#
#   docker run --rm poetry-versions:lts-latest versions numpy
#   docker run --rm poetry-versions:lts-latest test numpy 5
#   docker run --rm poetry-versions:lts-latest run numpy --limit 5 --first-only -v
#   docker run --rm -it poetry-versions:lts-latest                 # interactive REPL
#
# The tool builds a throwaway Poetry project inside the container and
# `poetry add`s each version into it, so the container needs network access to
# your registry. Point it at a registry and capture the report via a mount:
#   docker run --rm -e POETRY_REPOSITORIES_PYPI_URL=https://reg/simple \
#       -v "$PWD/out:/app/out" poetry-versions:lts-latest \
#       run numpy --index-url https://reg/simple --output out/report.json -v

ARG PYTHON_VERSION=3.13
FROM python:${PYTHON_VERSION}-slim

# poetry pinned to match main.DEFAULT_POETRY_VERSION so install-tests run against a known poetry.
ARG POETRY_VERSION=1.8.3

# Unbuffered stdout so verbose install streaming surfaces in real time through
# `docker run`/`docker logs`; skip .pyc clutter in the image.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# Install poetry (used by `poetry add` during install-tests). Version discovery
# itself hits the PyPI JSON API over stdlib urllib and needs no poetry.
RUN python -m pip install --no-cache-dir "poetry==${POETRY_VERSION}"

WORKDIR /app

# Only the three runtime modules (tests/CI/venvs excluded via .dockerignore).
COPY main.py sdk.py cli.py ./

# Run as a non-root user; /app stays writable for the throwaway test project and
# the JSON report the tool writes to the working directory.
RUN useradd --create-home --uid 10001 app \
    && chown -R app:app /app
USER app

# Container args become a single REPL command line; no args -> interactive shell.
ENTRYPOINT ["python", "cli.py"]
CMD []
