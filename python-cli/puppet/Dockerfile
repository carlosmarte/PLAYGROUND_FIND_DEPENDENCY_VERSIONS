# syntax=docker/dockerfile:1

# puppet-versions — probe which versions of a module install from a (custom)
# Puppet Forge. cli.py is the entrypoint: pass REPL commands as container args,
# or run with no args (and `-it`) for an interactive shell.
#
#   docker build -t puppet-versions:lts-latest .
#
#   docker run --rm puppet-versions:lts-latest versions puppetlabs-stdlib
#   docker run --rm puppet-versions:lts-latest test puppetlabs-stdlib 5
#   docker run --rm puppet-versions:lts-latest run puppetlabs-stdlib --limit 5 --first-only -v
#   docker run --rm -it puppet-versions:lts-latest             # interactive REPL
#
# The tool builds a throwaway target dir inside the container and `puppet module
# install`s each version into it, so the container needs network access to your
# Forge. Point it at a server and capture the report via a mount:
#   docker run --rm -e PUPPET_FORGE_SERVER=https://forgeapi.puppet.com \
#       -v "$PWD/out:/app/out" puppet-versions:lts-latest \
#       run puppetlabs-stdlib --forge-server https://forgeapi.puppet.com --output out/report.json -v

# puppet is not a pip package; the official Puppet image already ships the
# `puppet` binary on PATH. The tool itself is pure-Python stdlib, run via the
# python3 the base image carries.
FROM puppet/puppet-agent

# puppet version this image targets, echoed to match main.DEFAULT_PUPPET_VERSION.
ARG PUPPET_VERSION=8.10.0

# Unbuffered stdout so verbose install streaming surfaces in real time through
# `docker run`/`docker logs`; skip .pyc clutter in the image.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

# Only the three runtime modules (tests/CI/venvs excluded via .dockerignore).
COPY main.py sdk.py cli.py ./

# Run as a non-root user; /app stays writable for the throwaway target dir and
# the JSON report the tool writes to the working directory.
RUN useradd --create-home --uid 10001 app \
    && chown -R app:app /app
USER app

# Container args become a single REPL command line; no args -> interactive shell.
ENTRYPOINT ["python3", "cli.py"]
CMD []
