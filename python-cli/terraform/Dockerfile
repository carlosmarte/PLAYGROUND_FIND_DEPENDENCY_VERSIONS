# syntax=docker/dockerfile:1

# terraform-versions — probe which versions of a provider initialise from a
# (custom) Terraform registry. cli.py is the entrypoint: pass REPL commands as
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
#
# Base image `hashicorp/terraform` ships the terraform client; we add Python 3
# for the tool itself and override its entrypoint (alternatively use
# python:3.13-slim and install the terraform CLI).

ARG TERRAFORM_CLI_VERSION=1.9.8
FROM hashicorp/terraform:${TERRAFORM_CLI_VERSION}

# terraform version main.py expects by default (soft check; warns on drift).
ARG TERRAFORM_VERSION=1.9.8

# Unbuffered stdout so verbose init streaming surfaces in real time through
# `docker run`/`docker logs`; skip .pyc clutter in the image.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# Add Python 3 (the tool itself runs on Python; it wraps the terraform CLI).
# Reset the entrypoint the base image sets to `terraform` so cli.py drives.
RUN apk add --no-cache python3
ENTRYPOINT []

WORKDIR /app

# Only the three runtime modules (tests/CI/venvs excluded via .dockerignore).
COPY main.py sdk.py cli.py ./

# Run as a non-root user; /app stays writable for the throwaway init sandbox and
# the JSON report the tool writes to the working directory.
RUN adduser -D -u 10001 app \
    && chown -R app:app /app
USER app

# Container args become a single REPL command line; no args -> interactive shell.
ENTRYPOINT ["python3", "cli.py"]
CMD []
