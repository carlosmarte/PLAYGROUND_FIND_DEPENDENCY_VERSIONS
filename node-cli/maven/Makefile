# Makefile for maven-versions — Node setup, lint, and smoke checks.
#
# Quick start:
#   make setup     # verify Node/npm and pin npm
#   make ci        # what CI runs: setup + lint + smoke
#
# The project is dependency-free (Node built-ins only), so there is nothing to
# install beyond a pinned npm. (The tool itself shells out to `mvn`; Node only
# runs the stdlib-only driver.)

# ---- Config -----------------------------------------------------------------

NODE     ?= node
NPM      ?= npm
# npm pinned to keep the dev environment reproducible. The tool's own resolver
# pin is the maven version (see MAVEN_VERSION) that main.mjs defaults to.
NPM_VERSION ?= 10.9.2
# maven version main.mjs / Dockerfile default to, so the dev tooling matches the
# resolver/repository behaviour the tool tests against.
MAVEN_VERSION ?= 3.9.9

# Sentinel marks a provisioned environment so `make setup` is a no-op once done.
STAMP    := .make.stamp

# Docker image coordinates (override: make docker-build IMAGE=foo TAG=bar).
IMAGE ?= maven-versions
TAG   ?= lts-latest

.DEFAULT_GOAL := help

# ---- Phony targets ----------------------------------------------------------

.PHONY: help setup install lint smoke test ci run clean docker-build docker-run

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

setup: $(STAMP) ## Verify Node/npm and pin npm (idempotent)

$(STAMP):
	$(NODE) --version
	$(NPM) install -g "npm@$(NPM_VERSION)" || echo ">> could not pin npm (continuing)"
	@touch $(STAMP)
	@echo ">> environment ready (npm $(NPM_VERSION), maven $(MAVEN_VERSION))"

install: setup ## Alias for setup

lint: setup ## Syntax-check all modules to catch parse errors
	$(NODE) --check main.mjs
	$(NODE) --check sdk.mjs
	$(NODE) --check cli.mjs

smoke: setup ## Import modules and exercise the CLI + SDK entrypoints
	$(NODE) main.mjs --help >/dev/null
	$(NODE) -e "import('./sdk.mjs').then(s=>{const x=s.MavenVersionsSDK.fromArgv(['com.google.guava:guava','--limit','3','--first-only','-v']);if(x.config.package!=='com.google.guava:guava'||x.config.limit!==3||x.config.verbose!==true){console.error('sdk FAIL');process.exit(1)}console.log('sdk OK')})"
	@echo ">> smoke OK"

test: smoke ## No unit suite yet — run the smoke checks

ci: lint smoke ## What CI runs: lint + smoke

run: setup ## Launch the interactive REPL
	$(NODE) cli.mjs

docker-build: ## Build the container image ($(IMAGE):$(TAG))
	docker build -t $(IMAGE):$(TAG) .

docker-run: ## Run the image; pass REPL args via ARGS="versions com.google.guava:guava"
	docker run --rm $(IMAGE):$(TAG) $(ARGS)

clean: ## Remove the test local-repo, reports, and the setup stamp
	rm -rf .m2-test-repo node_modules installation_report.json $(STAMP)
