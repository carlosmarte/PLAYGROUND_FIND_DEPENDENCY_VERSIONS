# syntax=docker/dockerfile:1

# helm-versions — probe which versions of a chart pull from a (custom) Helm
# repository. cli.mjs is the entrypoint: pass REPL commands as container args, or
# run with no args (and `-it`) for an interactive shell.
#
#   docker build -t helm-versions:lts-latest .
#
#   docker run --rm helm-versions:lts-latest versions bitnami/nginx
#   docker run --rm helm-versions:lts-latest test bitnami/nginx 5
#   docker run --rm helm-versions:lts-latest run bitnami/nginx --limit 5 --first-only -v
#   docker run --rm -it helm-versions:lts-latest               # interactive REPL
#
# The tool shells out to the `helm` CLI to search/pull each chart version, so
# the container needs network access to your chart repo. Point it at a repo and
# capture the report via a mount:
#   docker run --rm -e HELM_REPO_URL=https://charts.example.com \
#       -v "$PWD/out:/app/out" helm-versions:lts-latest \
#       run bitnami/nginx --repo-url https://charts.example.com --output out/report.json -v

ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-slim

# helm version main.mjs expects by default (soft check; warns on drift).
ARG HELM_VERSION=3.16.3

# Unbuffered-ish stdout so verbose pull streaming surfaces in real time through
# `docker run`/`docker logs`.
ENV NODE_ENV=production

# The tool shells out to the `helm` CLI, which is NOT present in node:22-slim.
# Install the helm client so discovery (`helm search repo`) and pull
# (`helm pull`) work.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && curl -fsSL "https://get.helm.sh/helm-v${HELM_VERSION}-linux-$(dpkg --print-architecture).tar.gz" -o /tmp/helm.tgz \
    && tar -xzf /tmp/helm.tgz -C /tmp \
    && mv "/tmp/linux-$(dpkg --print-architecture)/helm" /usr/local/bin/helm \
    && rm -rf /tmp/helm.tgz "/tmp/linux-$(dpkg --print-architecture)" \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Only the three runtime modules + manifest (tests/CI/sandboxes excluded via
# .dockerignore).
COPY package.json main.mjs sdk.mjs cli.mjs ./

# Run as a non-root user; /app stays writable for the chart-pull destination and
# the JSON report the tool writes to the working directory.
RUN useradd --create-home --uid 10001 app \
    && chown -R app:app /app
USER app

# Container args become a single REPL command line; no args -> interactive shell.
ENTRYPOINT ["node", "cli.mjs"]
CMD []
