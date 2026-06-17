# Makefile for winget-versions — venv bootstrap, lint, and smoke checks.
#
# Quick start:
#   make setup     # create .venv and install/pin tooling
#   make ci        # what CI runs: setup + lint + smoke
#
# Everything lives in a project-local .venv so host Python stays untouched.
# The tool itself shells out to `winget` (Windows-only); only the Python harness
# needs the venv. winget must be on PATH (i.e. on Windows) for actual
# install-tests — the subprocess calls fail on Linux/macOS.

# ---- Config -----------------------------------------------------------------

PYTHON      ?= python3
VENV        ?= .venv
# pip pinned for the harness venv (the tool wraps winget, not pip).
PIP_VERSION ?= 26.1.1
# winget version main.py defaults to, so the dev environment matches the
# source/resolver behaviour the tool tests against.
WINGET_VERSION ?= 1.8.0

VENV_PY  := $(VENV)/bin/python
VENV_PIP := $(VENV)/bin/pip
# Sentinel marks a fully-provisioned venv so `make setup` is a no-op once done.
STAMP    := $(VENV)/.stamp

# Optional dependency manifests — installed only if present (project is stdlib).
REQUIREMENTS ?= requirements.txt
DEV_REQUIREMENTS ?= requirements-dev.txt

# Docker image coordinates (override: make docker-build IMAGE=foo TAG=bar).
IMAGE ?= winget-versions
TAG   ?= lts-latest

.DEFAULT_GOAL := help

# ---- Phony targets ----------------------------------------------------------

.PHONY: help venv setup install lint smoke test ci run clean docker-build docker-run

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

venv: $(VENV_PY) ## Create the virtualenv

$(VENV_PY):
	$(PYTHON) -m venv $(VENV)

setup: $(STAMP) ## Create venv and install/pin tooling (idempotent)

$(STAMP): $(VENV_PY)
	$(VENV_PIP) install --upgrade "pip==$(PIP_VERSION)"
	@if [ -f "$(REQUIREMENTS)" ]; then \
		echo ">> installing $(REQUIREMENTS)"; \
		$(VENV_PIP) install -r "$(REQUIREMENTS)"; \
	else \
		echo ">> no $(REQUIREMENTS) (stdlib-only project) — skipping"; \
	fi
	@if [ -f "$(DEV_REQUIREMENTS)" ]; then \
		echo ">> installing $(DEV_REQUIREMENTS)"; \
		$(VENV_PIP) install -r "$(DEV_REQUIREMENTS)"; \
	fi
	@touch $(STAMP)
	@echo ">> venv ready at $(VENV) (pip $(PIP_VERSION), winget $(WINGET_VERSION))"

install: setup ## Alias for setup

lint: setup ## Byte-compile all modules to catch syntax errors
	$(VENV_PY) -m compileall -q cli.py sdk.py main.py

smoke: setup ## Import modules and exercise the CLI + SDK entrypoints
	$(VENV_PY) -c "import main, sdk, cli; print('imports OK')"
	$(VENV_PY) main.py --help >/dev/null
	$(VENV_PY) -c "import sdk; s = sdk.WingetVersionsSDK.from_argv(['Git.Git', '--limit', '3', '--first-only', '-v']); assert s.config.package == 'Git.Git' and s.config.limit == 3 and s.config.verbose is True; print('sdk OK')"
	@echo ">> smoke OK"

test: smoke ## No unit suite yet — run the smoke checks

ci: lint smoke ## What CI runs: lint + smoke on a fresh venv

run: setup ## Launch the interactive REPL
	$(VENV_PY) cli.py

docker-build: ## Build the container image ($(IMAGE):$(TAG))
	docker build -t $(IMAGE):$(TAG) .

docker-run: ## Run the image; pass REPL args via ARGS="versions Git.Git"
	docker run --rm $(IMAGE):$(TAG) $(ARGS)

clean: ## Remove venvs (dev + test-install) and Python caches
	rm -rf $(VENV) .venv-test-install __pycache__ .pytest_cache
	find . -name '*.pyc' -delete
