# syntax=docker/dockerfile:1

# cran-versions — probe which versions of a package install from a (custom) CRAN
# mirror. cli.py is the entrypoint: pass REPL commands as container args, or run
# with no args (and `-it`) for an interactive shell.
#
#   docker build -t cran-versions:lts-latest .
#
#   docker run --rm cran-versions:lts-latest versions jsonlite
#   docker run --rm cran-versions:lts-latest test jsonlite 5
#   docker run --rm cran-versions:lts-latest run jsonlite --limit 5 --first-only -v
#   docker run --rm -it cran-versions:lts-latest                 # interactive REPL
#
# The tool builds a throwaway R library inside the container and installs each
# version into it via remotes::install_version, so the container needs network
# access to your CRAN mirror. Point it at a mirror and capture the report via a
# mount:
#   docker run --rm -e R_REPOS_URL=https://cloud.r-project.org \
#       -v "$PWD/out:/app/out" cran-versions:lts-latest \
#       run jsonlite --repos https://cloud.r-project.org --output out/report.json -v

# r-base ships R + Rscript; remotes is installed at build time for the install-tests.
FROM r-base:latest

# R version the test library expects (matches main.DEFAULT_R_VERSION).
ARG R_VERSION=4.4.2

# Unbuffered stdout so verbose install streaming surfaces in real time through
# `docker run`/`docker logs`; skip .pyc clutter in the image.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# Python (to run the tool) + remotes (used by remotes::install_version during
# install-tests). r-base is Debian-based, so apt provides python3.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/* \
    && Rscript -e "install.packages('remotes', repos='https://cloud.r-project.org')"

WORKDIR /app

# Only the three runtime modules (tests/CI/venvs excluded via .dockerignore).
COPY main.py sdk.py cli.py ./

# Run as a non-root user; /app stays writable for the throwaway test library and
# the JSON report the tool writes to the working directory.
RUN useradd --create-home --uid 10001 app \
    && chown -R app:app /app
USER app

# Container args become a single REPL command line; no args -> interactive shell.
ENTRYPOINT ["python3", "cli.py"]
CMD []
