# syntax=docker/dockerfile:1

# homebrew-versions — probe which versions of a formula fetch from the Homebrew
# registry. cli.mjs is the entrypoint: pass REPL commands as container args, or
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

# DEVIATION FROM THE node:22-slim REFERENCE: this tool shells out to `brew`,
# which is not present in node:22-slim. We base on the homebrew/brew image
# (which ships `brew`) and install Node via brew so cli.mjs can run. Discovery
# (the `versions` command) is HTTP-only (global fetch) and needs only Node; the
# fetch-tests need brew, which the base provides.
FROM homebrew/brew

# Unbuffered-ish stdout so verbose fetch streaming surfaces in real time through
# `docker run`/`docker logs`. Keep fetches fast by disabling the per-invocation
# tap auto-update.
ENV NODE_ENV=production \
    HOMEBREW_NO_AUTO_UPDATE=1

# Install Node via brew (the base ships brew but not Node).
RUN brew install node

WORKDIR /app

# Only the runtime modules + manifest (tests/CI/sandboxes excluded via
# .dockerignore).
COPY package.json main.mjs sdk.mjs cli.mjs ./

# NOTE: the homebrew/brew image already runs as the `linuxbrew` user; /app must
# stay writable for the throwaway download cache and the JSON report the tool
# writes to the working directory. For real `brew fetch` runs you may need to run
# as the brew owner, e.g. `docker run -u linuxbrew ...`.
USER linuxbrew

# Container args become a single REPL command line; no args -> interactive shell.
ENTRYPOINT ["node", "cli.mjs"]
CMD []
