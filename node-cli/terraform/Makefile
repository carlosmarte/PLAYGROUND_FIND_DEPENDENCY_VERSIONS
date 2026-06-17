# Makefile for terraform-versions — Node setup, lint, and smoke checks.
#
# Quick start:
#   make setup     # verify Node/npm
#   make ci        # what CI runs: setup + lint + smoke
#
# The project is dependency-free (Node built-ins only). The tool itself shells
# out to the host `terraform` CLI (and the registry HTTP API via global fetch);
# the Docker image provides terraform (or your host must have it on PATH for
# real init-tests).

# ---- Config -----------------------------------------------------------------

NODE     ?= node
NPM      ?= npm
# terraform version main.mjs expects by default (soft check, warns only).
TERRAFORM_VERSION ?= 1.9.8

# Sentinel marks a provisioned environment so `make setup` is a no-op once done.
STAMP    := .make.stamp

# Docker image coordinates (override: make docker-build IMAGE=foo TAG=bar).
IMAGE ?= terraform-versions
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
	@echo ">> environment ready (terraform $(TERRAFORM_VERSION))"

install: setup ## Alias for setup

lint: setup ## Syntax-check all modules to catch parse errors
	$(NODE) --check main.mjs
	$(NODE) --check sdk.mjs
	$(NODE) --check cli.mjs

smoke: setup ## Import modules and exercise the CLI + SDK entrypoints
	$(NODE) main.mjs --help >/dev/null
	$(NODE) -e "import('./sdk.mjs').then(s=>{const x=s.TerraformVersionsSDK.fromArgv(['hashicorp/aws','--limit','3','--first-only','-v']);if(x.config.package!=='hashicorp/aws'||x.config.limit!==3||x.config.verbose!==true){console.error('sdk FAIL');process.exit(1)}console.log('sdk OK')})"
	@echo ">> smoke OK"

test: smoke ## No unit suite yet — run the smoke checks

ci: lint smoke ## What CI runs: lint + smoke

run: setup ## Launch the interactive REPL
	$(NODE) cli.mjs

docker-build: ## Build the container image ($(IMAGE):$(TAG))
	docker build -t $(IMAGE):$(TAG) .

docker-run: ## Run the image; pass REPL args via ARGS="versions hashicorp/aws"
	docker run --rm $(IMAGE):$(TAG) $(ARGS)

clean: ## Remove the init sandbox, reports, and the setup stamp
	rm -rf .venv-test-install node_modules installation_report.json $(STAMP)
