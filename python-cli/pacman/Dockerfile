# syntax=docker/dockerfile:1

# pacman-versions — probe which versions of a package install from a (custom)
# Arch pacman repository / archive. cli.py is the entrypoint: pass REPL commands
# as container args, or run with no args (and `-it`) for an interactive shell.
#
#   docker build -t pacman-versions:lts-latest .
#
#   docker run --rm pacman-versions:lts-latest versions bash
#   docker run --rm pacman-versions:lts-latest test bash 5
#   docker run --rm pacman-versions:lts-latest run bash --limit 5 --first-only -v
#   docker run --rm -it pacman-versions:lts-latest              # interactive REPL
#
# The tool builds a throwaway pacman cache inside the container and downloads
# each version into it, so the container needs network access to your
# repository / the Arch archive. Capture the report via a mount:
#   docker run --rm -e PACMAN_REPOSITORY=https://archive.archlinux.org \
#       -v "$PWD/out:/app/out" pacman-versions:lts-latest \
#       run bash --repository https://archive.archlinux.org --output out/report.json -v

# Arch base so the native `pacman` CLI (and `vercmp`) the tool wraps is present,
# and Python (python3) is installed for the wrapper itself.
FROM archlinux:latest

# pacman version the tool expects (advisory; matches main.DEFAULT_PACMAN_VERSION).
ARG PACMAN_VERSION=6.1.0

# Unbuffered stdout so verbose install streaming surfaces in real time through
# `docker run`/`docker logs`; skip .pyc clutter in the image.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# Install Python 3 (the wrapper) alongside the pacman the image already ships.
RUN pacman -Sy --noconfirm python \
    && pacman -Scc --noconfirm

WORKDIR /app

# Only the three runtime modules (tests/CI/venvs excluded via .dockerignore).
COPY main.py sdk.py cli.py ./

# Run as a non-root user; /app stays writable for the throwaway test cache and
# the JSON report the tool writes to the working directory.
RUN useradd --create-home --uid 10001 app \
    && chown -R app:app /app
USER app

# Container args become a single REPL command line; no args -> interactive shell.
ENTRYPOINT ["python3", "cli.py"]
CMD []
