# syntax=docker/dockerfile:1

# twine-versions — probe which versions of a package have valid distribution
# metadata (via `twine check`). cli.py is the entrypoint: pass REPL commands as
# container args, or run with no args (and `-it`) for an interactive shell.
#
# NOTE: twine is publish-side; this clone repurposes `twine check` as a
# metadata-validity probe — see main.py's module docstring.
#
#   docker build -t twine-versions:lts-latest .
#
#   docker run --rm twine-versions:lts-latest versions numpy
#   docker run --rm twine-versions:lts-latest test numpy 5
#   docker run --rm twine-versions:lts-latest run numpy --limit 5 --first-only -v
#   docker run --rm -it twine-versions:lts-latest                 # interactive REPL
#
# The tool downloads each version's distribution into a scratch dir inside the
# container and runs `twine check` on it, so the container needs network access
# to your registry. Point it at a registry and capture the report via a mount:
#   docker run --rm -e TWINE_REPOSITORY_URL=https://reg/simple \
#       -v "$PWD/out:/app/out" twine-versions:lts-latest \
#       run numpy --index-url https://reg/simple --output out/report.json -v

ARG PYTHON_VERSION=3.13
FROM python:${PYTHON_VERSION}-slim

# twine pinned to match main.DEFAULT_TWINE_VERSION so checks run the known validators.
ARG TWINE_VERSION=5.1.1

# Unbuffered stdout so verbose streaming surfaces in real time through
# `docker run`/`docker logs`; skip .pyc clutter in the image.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# Install twine (used by `twine check` during metadata-tests). Version discovery
# itself hits the PyPI JSON API over stdlib urllib and needs no twine.
RUN python -m pip install --no-cache-dir "twine==${TWINE_VERSION}"

WORKDIR /app

# Only the three runtime modules (tests/CI/venvs excluded via .dockerignore).
COPY main.py sdk.py cli.py ./

# Run as a non-root user; /app stays writable for the scratch download dir and
# the JSON report the tool writes to the working directory.
RUN useradd --create-home --uid 10001 app \
    && chown -R app:app /app
USER app

# Container args become a single REPL command line; no args -> interactive shell.
ENTRYPOINT ["python", "cli.py"]
CMD []
