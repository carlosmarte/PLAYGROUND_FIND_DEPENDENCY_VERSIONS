# Adaptation Spec — porting the `pip` reference to other registries

This spec tells you how to produce a registry-specific clone of the reference
tool at `../pip/`. Every clone is a small **Python** tool (stdlib only) that
wraps a package-manager / registry CLI via `subprocess`, exactly mirroring the
three-layer architecture of the reference:

```
  interactive shell (cli.py) ─┐
  external scripts            ─┼─►  SDK (sdk.py)  ─►  Engine (main.py)
  one-shot CLI (main.py)      ─┘
```

## What to read first

Read ALL of these reference files before writing anything; your output must
mirror their structure, docstrings, comments, and patterns 1:1, swapping only
the registry-specific pieces:

- `../pip/main.py`     — stateless engine (pure functions take resolved cfg)
- `../pip/sdk.py`      — `PipVersionsSDK`, `Config`, `Report`, hooks, funnels
- `../pip/cli.py`      — `cmd.Cmd` REPL that is a thin view over the SDK
- `../pip/Makefile`    — stamp-guarded setup, lint, smoke, ci, docker targets
- `../pip/Dockerfile`  — slim pinned base, non-root user, args→command
- `../pip/.dockerignore`

## Files to produce (per registry directory)

Create the directory `../<slug>/` and write exactly these 6 files:

1. `main.py` — engine
2. `sdk.py` — SDK
3. `cli.py` — REPL
4. `Makefile`
5. `Dockerfile`
6. `.dockerignore`

Keep the tool **Python + stdlib only** (argparse, json, os, re, subprocess,
sys, venv/tempfile, cmd, shlex, dataclasses). The tool *itself* runs on Python;
it merely shells out to the ecosystem's native CLI. This keeps all 33 clones
consistent and matches the reference (which is Python wrapping the `pip` CLI).

## Naming conventions (replace `Pip`/`pip` consistently)

| Reference token            | Replace with (example: npm)        |
|----------------------------|------------------------------------|
| `PipVersionsSDK`           | `NpmVersionsSDK`                    |
| `PipVersionsError`         | `NpmVersionsError`                  |
| `PipVersionsREPL`          | `NpmVersionsREPL`                   |
| `DEFAULT_PIP_VERSION`      | `DEFAULT_NPM_VERSION` (tool version)|
| prompt `(pip-versions)`    | `(npm-versions)`                    |
| image `pip-versions`       | `npm-versions`                      |
| `installation_report.json` | keep the same filename             |

Use the registry's natural CamelCase for the class prefix (e.g. `Cargo`, `Go`,
`Cran`, `Maven`, `NuGet`, `Helm`, `Docker`, `Apk`, `Apt`, `Spm`, `Hex`, `Cpan`).

## What stays IDENTICAL (the patterns — do not drop any)

- **Layered funnel**: `cli → sdk → main`; the SDK is the single funnel.
- **Stateless engine**: `main.py` is free functions taking a resolved `cfg` dict.
- **Config dataclass** as session state; REPL/SDK are views onto it.
- **Layered config resolution**: `ENV_DEFAULTS < os.environ < overrides`, plus an
  index/registry-url precedence chain (`resolve_index_url` analog).
- **`_UNSET` sentinel** for "argument not supplied" vs a meaningful `None`.
- **`Report`** dataclass with `installable` / `failed` / `first_installable`
  derived properties, `__iter__`, `__len__`, plus an **output surface**
  `to_dict()` / `to_json()` / `write_json(path)` (`toDict`/`toJson`/`writeJson`
  in node — lowercase `json` to dodge the `JSON.stringify` hook). `to_dict()`'s
  registry-url key mirrors THIS ecosystem's own field name (`index_url`,
  `galaxy_server`, `forge_server`, `vagrant_server`, …).
- **Extension hooks** `before_probe` / `after_probe`.
- **Lazy provisioning + cache + `invalidate_venv()`** for the isolated test env.
- **Subprocess orchestration**: build arg list, inject env, capture, classify
  success/failure on returncode, extract a compact last-line for the report.
- **Dual-mode output**: `verbose` streams live (`_stream`) else captures.
- **Incremental crash-safe persistence**: rewrite the full JSON report after
  every version iteration.
- **REPL** commands: `registry/index`, `package`, `limit`, `output`, `venv`,
  the tool-version command (`pip` analog), `verbose`, `show`, `env`, `versions`,
  `find`, `test [MAX]`, `run`, `quit/exit/EOF`. One-shot mode: args become one
  REPL line then exit (container-friendly).
- **Inline `--output=PATH`** on any command: data commands (`versions`/`find`/
  `test`) stash a structured payload (`{command, …Report.to_dict()}`) that is
  written as JSON; other commands fall back to teed console text. Backed by the
  SDK output surface above (and the module-level `versions_output()` funnel), so
  an external caller gets the same JSON without driving the REPL.
- **Pinned tool version**: one constant echoed across `main.py`, `Makefile`,
  `Dockerfile`.
- **Makefile**: `help setup install lint smoke test ci run clean docker-build
  docker-run`, stamp sentinel, `compileall` lint, smoke that imports + exercises
  `from_argv`.
- **Dockerfile**: slim pinned base for THAT ecosystem, non-root uid 10001 user,
  copy only the 3 modules, `ENTRYPOINT ["python", "cli.py"]`.

## What CHANGES per registry (the subprocess details)

Adapt these engine functions to the native CLI:

- **`get_available_versions(...)`** — run the registry's "list versions" command,
  parse its output (JSON when available, else regex), return versions
  **newest-first**.
- **`setup_venv(...)`** — provision an isolated sandbox for that ecosystem (a
  temp project dir, a throwaway venv/prefix, a scratch toolchain home). Return
  whatever handle the test step needs (a path). Keep the lazy-cache + pin shape.
- **`test_installations(...)`** — install/fetch each version into the sandbox,
  classify success on returncode, persist the JSON report incrementally.
- **`resolve_index_url(...)`** / `ENV_DEFAULTS` — use the ecosystem's registry
  env var(s) and default public registry URL.

Keep the same function names where they still make sense; it's fine to keep
`setup_venv`/`venv_dir`/`pip_version` names generic-ish, but prefer renaming the
tool-version concept to the ecosystem's tool (e.g. `npm_version`, `go_version`)
while keeping the `--pip-version`→`--<tool>-version` CLI flag analog and the REPL
command. The JSON report schema stays `{version, status, log|error}`.

## Per-registry CLI cheat-sheet

Use these as the native commands to wrap (the agent prompt names which subset is
yours). Where a true "list all versions" command is weak, use the registry's
HTTP JSON API via `urllib.request` (stdlib) and document it. Always degrade
gracefully and keep `--verbose` debuggable.

- **npm**: list `npm view <pkg> versions --json`; test `npm install <pkg>@<ver>`
  in a temp prefix (`--prefix`); registry `--registry $NPM_CONFIG_REGISTRY`
  (default `https://registry.npmjs.org`).
- **pnpm**: list `pnpm view <pkg> versions --json`; test `pnpm add <pkg>@<ver>`
  in a temp dir; `--registry` (default `https://registry.npmjs.org`).
- **jsr**: list via `https://jsr.io/@<scope>/<name>/meta.json` (versions map);
  test `npx jsr add @<scope>/<name>@<ver>` (or `deno add`); registry
  `https://jsr.io`.
- **cargo** (Rust): list via crates.io API
  `https://crates.io/api/v1/crates/<crate>` (`versions[].num`) or sparse index;
  test in a temp crate: `cargo add <crate>@<ver>` then `cargo fetch`; registry
  `--registry`/`$CARGO_REGISTRIES_*` (default crates.io).
- **go**: list `go list -m -versions <module>`; test `go get <module>@<ver>`
  inside a temp module; registry `$GOPROXY` (default `https://proxy.golang.org`).
- **spm** (Swift): list `git ls-remote --tags <repo-url>` (parse semver tags);
  test by writing a Package.swift pinning the version then `swift package resolve`.
- **maven**: list from `maven-metadata.xml` at
  `<repo>/<group-path>/<artifact>/maven-metadata.xml`; test
  `mvn dependency:get -Dartifact=<g>:<a>:<v>`; repo default Maven Central.
- **gradle**: same Maven coordinates/metadata for listing; test by generating a
  tiny build.gradle requiring `<g>:<a>:<v>` and running
  `gradle dependencies --refresh-dependencies` (or `dependencyInsight`).
- **clojars**: list via `https://clojars.org/api/artifacts/<group>/<artifact>`
  (or Maven metadata on `https://repo.clojars.org`); test via Maven-style
  `mvn dependency:get` or a deps.edn + `clojure -P`.
- **nuget**: list via `https://api.nuget.org/v3-flatcontainer/<id>/index.json`
  (`versions[]`); test `dotnet add package <id> -v <ver>` in a temp project or
  `nuget install <id> -Version <ver>`; `--source`.
- **conda**: list `conda search <pkg> --json` (parse versions); test
  `conda create -y -n <tmp> <pkg>=<ver>` (or `--prefix`); channel `-c` default
  `defaults`/`conda-forge`.
- **cran** (R): list via `https://crandb.r-pkg.org/<pkg>/all` (versions map) or
  the CRAN archive; test
  `Rscript -e 'remotes::install_version("<pkg>", "<ver>", repos="<repo>")'`;
  repo default `https://cloud.r-project.org`.
- **dart** (pub): list via `https://pub.dev/api/packages/<pkg>` (`versions[]`);
  test `dart pub add <pkg>:<ver>` in a temp package; `$PUB_HOSTED_URL` default
  `https://pub.dev`.
- **hex** (Elixir/Erlang): list `mix hex.info <pkg>` (or API
  `https://hex.pm/api/packages/<pkg>`); test `mix hex.package fetch <pkg> <ver>`
  or a temp mix project + `mix deps.get`; `$HEX_MIRROR` default `https://repo.hex.pm`.
- **cpan** (Perl): list via MetaCPAN
  `https://fastapi.metacpan.org/v1/release/<Dist>` releases; test
  `cpanm <Module>@<ver>` into a temp `--local-lib`; default `https://www.cpan.org`.
- **cabal** (Haskell): list via Hackage
  `https://hackage.haskell.org/package/<pkg>/preferred` or the package page JSON;
  test `cabal get <pkg>-<ver>` (or a temp project + `cabal build`); default Hackage.
- **stack** (Haskell): list via Hackage (same as cabal) or Stackage snapshots;
  test by writing a stack.yaml + package.yaml pinning `<pkg>-<ver>` then
  `stack build --dry-run`; default Stackage/Hackage.
- **docker**: list tags via registry v2 API
  `https://<registry>/v2/<repo>/tags/list` (auth token for Docker Hub) or
  `https://hub.docker.com/v2/repositories/<repo>/tags`; test `docker pull
  <repo>:<tag>`; default `registry-1.docker.io` / `docker.io`.
- **helm**: list `helm search repo <repo>/<chart> --versions --output json`
  (after `helm repo add`); test `helm pull <repo>/<chart> --version <ver>` into a
  temp dir; repo is a chart repo URL.
- **terraform**: list providers via
  `https://registry.terraform.io/v1/providers/<ns>/<name>/versions` (or modules
  `/v1/modules/...`); test by writing a config with `required_providers` pinned
  then `terraform init`; default `registry.terraform.io`.
- **vcpkg**: list from the versions DB
  (`versions/<x->/<port>.json` in a vcpkg checkout) or `vcpkg search <port>`;
  test `vcpkg install <port>` (overlay/builtin baseline); default vcpkg registry.
- **ansible** (Galaxy): list via
  `https://galaxy.ansible.com/api/v3/plugin/ansible/content/published/collections/index/<ns>/<name>/versions/`
  (or `ansible-galaxy collection list`); test `ansible-galaxy collection install
  <ns>.<name>:<ver> -p <tmp>`; `$ANSIBLE_GALAXY_SERVER` default
  `https://galaxy.ansible.com`.
- **vagrant**: list via `https://app.vagrantup.com/api/v1/box/<user>/<box>`
  (`versions[].version`); test `vagrant box add <user>/<box> --box-version <ver>`
  (use `--provider` + a temp `VAGRANT_HOME`); default `app.vagrantup.com`.
- **puppet** (Forge): list via
  `https://forgeapi.puppet.com/v3/modules/<user>-<mod>` (`releases[].version`);
  test `puppet module install <user>-<mod> --version <ver> --target-dir <tmp>`;
  default `https://forgeapi.puppet.com`.
- **alpine** (apk): list `apk policy <pkg>` (or `apk version`/repo APKINDEX);
  test `apk add --root <tmp> --initdb <pkg>=<ver>`; repo via `--repository`.
- **debian** (apt): list `apt-cache madison <pkg>` (versions in col 2); test
  `apt-get install --download-only <pkg>=<ver>` (or into a temp root); repo via
  sources.list.
- **rpm**: list `dnf --showduplicates list <pkg>` (or `repoquery`); test
  `dnf install --downloadonly --downloaddir=<tmp> <pkg>-<ver>`; repo config.
- **pacman** (Arch): list via `pacman -Si <pkg>` / Arch archive
  `https://archive.archlinux.org/packages/<x>/<pkg>/`; test `pacman -Sw
  --noconfirm <pkg>` (download to a temp cache `--cachedir`); repo via mirrorlist.
- **homebrew** (macOS): list via
  `https://formulae.brew.sh/api/formula/<formula>.json` (`versions.stable` +
  history) or `brew info --json <formula>`; test `brew fetch <formula>` (or
  `brew install --dry-run`); default Homebrew API.
- **chocolatey** (Windows): list `choco search <pkg> --all-versions --limit-output`
  (or the NuGet v2 feed `https://community.chocolatey.org/api/v2/`); test `choco
  install <pkg> --version <ver> -y --no-progress` (or `--noop`); `--source`.
- **winget** (Windows): list `winget show <pkg> --versions`; test `winget
  install --id <pkg> --version <ver> --accept-package-agreements` (or
  `--download`); source `winget` default.
- **uv** (Python): list `uv pip index versions <pkg>` (parse "Available
  versions:") or the PyPI simple/JSON API; test `uv pip install <pkg>==<ver>`
  into a `uv venv`; `$UV_INDEX_URL`/`--index-url` default
  `https://pypi.org/simple`.
- **poetry** (Python): list via PyPI JSON `https://pypi.org/pypi/<pkg>/json`
  (`releases` keys, sorted) or `poetry search`; test in a temp project
  `poetry add <pkg>==<ver>`; source via `[[tool.poetry.source]]` /
  `$POETRY_REPOSITORIES_*`; default PyPI.
- **twine** (Python): twine is **publish-side**; adapt by discovering versions
  from the PyPI JSON API (`https://pypi.org/pypi/<pkg>/json`) and "testing" each
  via `pip download <pkg>==<ver> --no-deps -d <tmp>` then `twine check <tmp>/*`
  (validates the distribution metadata). Document that twine itself uploads;
  this clone repurposes it as a metadata-validity probe. `--repository-url`
  default PyPI.

## Acceptance per directory

- `python3 main.py --help` works (argparse wired).
- `python3 -c "import main, sdk, cli"` succeeds (stdlib-only imports).
- `make lint` (compileall) passes; `make smoke` exercises `from_argv`.
- All 17 patterns are visibly present (same docstrings/comments style as `pip`).

Match the reference's tone: thorough module docstrings, the same inline comments
explaining *why*, the same help text shapes.
