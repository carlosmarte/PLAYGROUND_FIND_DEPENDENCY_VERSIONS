# syntax=docker/dockerfile:1

# terraform-versions — probe which versions of a provider initialise from a
# (custom) Terraform registry. cli.mjs is the entrypoint: pass REPL commands as
# container args, or run with no args (and `-it`) for an interactive shell.
#
#   docker build -t terraform-versions:lts-latest .
#
#   docker run --rm terraform-versions:lts-latest versions hashicorp/aws
#   docker run --rm terraform-versions:lts-latest test hashicorp/aws 5
#   docker run --rm terraform-versions:lts-latest run hashicorp/aws --limit 5 --first-only -v
#   docker run --rm -it terraform-versions:lts-latest          # interactive REPL
#
# The tool writes a throwaway config inside the container and runs `terraform
# init` against each version, so the container needs network access to your
# registry. Point it at a registry and capture the report via a mount:
#   docker run --rm -e TF_REGISTRY=registry.example.com \
#       -v "$PWD/out:/app/out" terraform-versions:lts-latest \
#       run hashicorp/aws --registry registry.example.com --output out/report.json -v

ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-slim

# terraform version main.mjs expects by default (soft check; warns on drift).
# The init-tests shell out to the `terraform` CLI, which node:22-slim does not
# ship, so we download and install it from the official release archive.
ARG TERRAFORM_VERSION=1.9.8

# Unbuffered-ish stdout so verbose init streaming surfaces in real time through
# `docker run`/`docker logs`.
ENV NODE_ENV=production

# Install the terraform CLI (used by `terraform init` during init-tests).
# Version discovery itself hits the registry HTTP API over global fetch and
# needs no terraform binary.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates unzip \
    && curl -fsSL "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_amd64.zip" -o /tmp/terraform.zip \
    && unzip /tmp/terraform.zip -d /usr/local/bin \
    && rm /tmp/terraform.zip \
    && apt-get purge -y unzip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Only the runtime modules + manifest (tests/CI/sandboxes excluded via
# .dockerignore).
COPY package.json main.mjs sdk.mjs cli.mjs ./

# Run as a non-root user; /app stays writable for the throwaway init sandbox and
# the JSON report the tool writes to the working directory.
RUN useradd --create-home --uid 10001 app \
    && chown -R app:app /app
USER app

# Container args become a single REPL command line; no args -> interactive shell.
ENTRYPOINT ["node", "cli.mjs"]
CMD []
