# syntax=docker/dockerfile:1

# vagrant-versions — probe which versions of a box install from a (custom)
# Vagrant Cloud. cli.py is the entrypoint: pass REPL commands as container args,
# or run with no args (and `-it`) for an interactive shell.
#
#   docker build -t vagrant-versions:lts-latest .
#
#   docker run --rm vagrant-versions:lts-latest versions hashicorp/bionic64
#   docker run --rm vagrant-versions:lts-latest test hashicorp/bionic64 5
#   docker run --rm vagrant-versions:lts-latest run hashicorp/bionic64 --limit 5 --first-only -v
#   docker run --rm -it vagrant-versions:lts-latest            # interactive REPL
#
# The tool builds a throwaway VAGRANT_HOME inside the container and `vagrant box
# add`s each version into it, so the container needs network access to your
# Vagrant Cloud. Point it at a server and capture the report via a mount:
#   docker run --rm -e VAGRANT_SERVER_URL=https://app.vagrantup.com \
#       -v "$PWD/out:/app/out" vagrant-versions:lts-latest \
#       run hashicorp/bionic64 --vagrant-server https://app.vagrantup.com --output out/report.json -v

# vagrant is not a pip package; the official HashiCorp image already ships the
# `vagrant` binary on PATH. The tool itself is pure-Python stdlib, run via the
# python3 the base image carries.
FROM hashicorp/vagrant

# vagrant version this image targets, echoed to match main.DEFAULT_VAGRANT_VERSION.
ARG VAGRANT_VERSION=2.4.1

# Unbuffered stdout so verbose install streaming surfaces in real time through
# `docker run`/`docker logs`; skip .pyc clutter in the image.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

# Only the three runtime modules (tests/CI/venvs excluded via .dockerignore).
COPY main.py sdk.py cli.py ./

# Run as a non-root user; /app stays writable for the throwaway VAGRANT_HOME and
# the JSON report the tool writes to the working directory.
RUN useradd --create-home --uid 10001 app \
    && chown -R app:app /app
USER app

# Container args become a single REPL command line; no args -> interactive shell.
ENTRYPOINT ["python3", "cli.py"]
CMD []
