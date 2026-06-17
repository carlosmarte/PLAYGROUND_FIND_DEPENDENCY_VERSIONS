# syntax=docker/dockerfile:1

# homebrew-versions — probe which versions of a formula fetch from the Homebrew
# registry. cli.py is the entrypoint: pass REPL commands as container args, or
# run with no args (and `-it`) for an interactive shell.
#
#   docker build -t homebrew-versions:lts-latest .
#
#   docker run --rm homebrew-versions:lts-latest versions wget
#   docker run --rm homebrew-versions:lts-latest test wget 5
#   docker run --rm homebrew-versions:lts-latest run wget --limit 5 --first-only -v
#   docker run --rm -it homebrew-versions:lts-latest             # interactive REPL
#
# IMPORTANT: brew installs/fetches only the CURRENT stable of a formula, so
# historical-version probing is best-effort — `brew fetch` validates that the
# formula is fetchable but cannot pin arbitrary past versions; versioned-formula
# NAMES (e.g. python@3.11) fetch directly.
#
# The tool builds a throwaway brew download cache inside the container and
# `brew fetch`es each token into it, so the container needs network access to
# the Homebrew CDN. Point it at a source and capture the report via a mount:
#   docker run --rm -e HOMEBREW_SOURCE=https://formulae.brew.sh \
#       -v "$PWD/out:/app/out" homebrew-versions:lts-latest \
#       run wget --source https://formulae.brew.sh --output out/report.json -v

# The homebrew/brew image already ships `brew` AND a Python 3 interpreter, so
# the (stdlib-only) Python harness can drive brew directly.
FROM homebrew/brew

# Unbuffered stdout so verbose fetch streaming surfaces in real time through
# `docker run`/`docker logs`; skip .pyc clutter in the image. Keep fetches fast
# by disabling the per-invocation tap auto-update.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HOMEBREW_NO_AUTO_UPDATE=1

WORKDIR /app

# Only the three runtime modules (tests/CI/venvs excluded via .dockerignore).
COPY main.py sdk.py cli.py ./

# Run as a non-root user; /app stays writable for the throwaway download cache
# and the JSON report the tool writes to the working directory. NOTE: the
# homebrew/brew image already runs as the `linuxbrew` user; we still create an
# `app` user (uid 10001) and chown /app for parity with the reference. For real
# `brew fetch` runs you may need to run as the brew owner instead, e.g.
# `docker run -u linuxbrew ...`.
RUN useradd --create-home --uid 10001 app \
    && chown -R app:app /app
USER app

# Container args become a single REPL command line; no args -> interactive shell.
ENTRYPOINT ["python3", "cli.py"]
CMD []
