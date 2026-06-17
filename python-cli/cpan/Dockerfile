# syntax=docker/dockerfile:1

# cpan-versions — probe which versions of a distribution install from a (custom)
# CPAN mirror. cli.py is the entrypoint: pass REPL commands as container args, or
# run with no args (and `-it`) for an interactive shell.
#
#   docker build -t cpan-versions:lts-latest .
#
#   docker run --rm cpan-versions:lts-latest versions JSON
#   docker run --rm cpan-versions:lts-latest test JSON 5
#   docker run --rm cpan-versions:lts-latest run JSON --limit 5 --first-only -v
#   docker run --rm -it cpan-versions:lts-latest                 # interactive REPL
#
# The tool builds a throwaway local-lib sandbox inside the container and runs
# `cpanm --local-lib` for each version, so the container needs network access to
# your mirror. Point it at a mirror and capture the report via a mount:
#   docker run --rm -e PERL_CPANM_MIRROR=https://www.cpan.org \
#       -v "$PWD/out:/app/out" cpan-versions:lts-latest \
#       run JSON --index-url https://www.cpan.org --output out/report.json -v

# perl slim ships perl; we install cpanm into it below. Python3 comes from the
# base's Debian layer (installed explicitly to be safe), since the tool itself
# is Python + stdlib only and merely shells out to cpanm.
ARG PERL_VERSION=5.40
FROM perl:${PERL_VERSION}-slim

# cpanm version the tool expects (matches main.DEFAULT_CPANM_VERSION). Installed
# via cpan/App::cpanminus so install-tests run against a known cpanm.
ARG CPANM_VERSION=1.7047

# Unbuffered stdout so verbose install streaming surfaces in real time through
# `docker run`/`docker logs`; skip .pyc clutter in the image.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PERL_CPANM_MIRROR=https://www.cpan.org

# Python3 to run the tool; cpanm for the install-tests it shells out to.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 cpanminus ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Only the three runtime modules (tests/CI/venvs excluded via .dockerignore).
COPY main.py sdk.py cli.py ./

# Run as a non-root user; /app stays writable for the throwaway local-lib
# sandbox and the JSON report the tool writes to the working directory.
RUN useradd --create-home --uid 10001 app \
    && chown -R app:app /app
USER app

# Container args become a single REPL command line; no args -> interactive shell.
ENTRYPOINT ["python3", "cli.py"]
CMD []
