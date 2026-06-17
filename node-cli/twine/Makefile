# Makefile for twine-versions — Node setup, lint, and smoke checks.
#
# Quick start:
#   make setup     # verify Node/npm
#   make ci        # what CI runs: setup + lint + smoke
#
# The project is dependency-free (Node built-ins only). The tool itself shells
# out to `python3 -m pip download` and `python3 -m twine check`, which the Docker
# image provides (or your host must have Python 3 + twine on PATH for real
# metadata-tests). Version discovery hits the PyPI JSON API via global fetch.

# ---- Config -----------------------------------------------------------------

NODE     ?= node
NPM      ?= npm
# twine pinned to the same version main.mjs defaults to, so the dev environment
# runs the same `twine check` metadata validators the tool tests against.
TWINE_VERSION ?= 5.1.1

# Sentinel marks a provisioned environment so `make setup` is a no-op once done.
STAMP    := .make.stamp

# Docker image coordinates (override: make docker-build IMAGE=foo TAG=bar).
IMAGE ?= twine-versions
TAG   ?= lts-latest

.DEFAULT_GOAL := help

# ---- Phony targets ----------------------------------------------------------

.PHONY: help setup install lint smoke test ci run clean docker-build docker-run

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

setup: $(STAMP) ## Verify Node/npm (idempotent)

$(STAMP):
	$(NODE) --version
	@touch $(STAMP)
	@echo ">> environment ready (twine $(TWINE_VERSION))"

install: setup ## Alias for setup

lint: setup ## Syntax-check all modules to catch parse errors
	$(NODE) --check main.mjs
	$(NODE) --check sdk.mjs
	$(NODE) --check cli.mjs

smoke: setup ## Import modules and exercise the CLI + SDK entrypoints
	$(NODE) main.mjs --help >/dev/null
	$(NODE) -e "import('./sdk.mjs').then(s=>{const x=s.TwineVersionsSDK.fromArgv(['numpy','--limit','3','--first-only','-v']);if(x.config.package!=='numpy'||x.config.limit!==3||x.config.verbose!==true){console.error('sdk FAIL');process.exit(1)}console.log('sdk OK')})"
	@echo ">> smoke OK"

test: smoke ## No unit suite yet — run the smoke checks

ci: lint smoke ## What CI runs: lint + smoke

run: setup ## Launch the interactive REPL
	$(NODE) cli.mjs

docker-build: ## Build the container image ($(IMAGE):$(TAG))
	docker build -t $(IMAGE):$(TAG) .

docker-run: ## Run the image; pass REPL args via ARGS="versions numpy"
	docker run --rm $(IMAGE):$(TAG) $(ARGS)

clean: ## Remove the scratch download dir, reports, and the setup stamp
	rm -rf .venv-test-install node_modules installation_report.json $(STAMP)
