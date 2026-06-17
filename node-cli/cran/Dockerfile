# syntax=docker/dockerfile:1

# cran-versions — probe which versions of a package install from a (custom) CRAN
# mirror. cli.mjs is the entrypoint: pass REPL commands as container args, or run
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

ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-slim

# R version the test library expects (matches main.DEFAULT_R_VERSION).
ARG R_VERSION=4.4.2

# Unbuffered-ish stdout so verbose install streaming surfaces in real time
# through `docker run`/`docker logs`.
ENV NODE_ENV=production

# node:22-slim has neither R nor Rscript; the tool shells out to Rscript +
# remotes::install_version for install-tests, so install R and the `remotes`
# package here. (Discovery uses crandb over fetch(), which Node provides
# natively.) r-base-core comes from Debian; remotes is installed via Rscript.
RUN apt-get update \
    && apt-get install -y --no-install-recommends r-base-core ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && Rscript -e "install.packages('remotes', repos='https://cloud.r-project.org')"

WORKDIR /app

# Only the three runtime modules + manifest (tests/CI/sandboxes excluded via
# .dockerignore).
COPY package.json main.mjs sdk.mjs cli.mjs ./

# Run as a non-root user; /app stays writable for the throwaway test library and
# the JSON report the tool writes to the working directory.
RUN useradd --create-home --uid 10001 app \
    && chown -R app:app /app
USER app

# Container args become a single REPL command line; no args -> interactive shell.
ENTRYPOINT ["node", "cli.mjs"]
CMD []
