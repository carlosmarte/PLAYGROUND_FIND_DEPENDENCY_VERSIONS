# PLAYGROUND_FIND_DEPENDENCY_VERSIONS — node-cli

Node.js (ESM `.mjs`) port of the `python-cli` tooling: per-ecosystem CLIs that
probe which versions of a package install cleanly from a (custom) registry.

Each subdirectory targets one package manager and ships the same three-layer
design, dependency-free (Node built-ins only):

```
cli.mjs (REPL)  ->  sdk.mjs (SDK)  ->  main.mjs (engine)
```

- `main.mjs` — the engine: discover advertised versions, install-test each in an
  isolated sandbox, write an incremental JSON report. Also a plain CLI.
- `sdk.mjs` — a programmatic SDK (the single funnel for every caller) with a
  `Config`/`Report` surface and `beforeProbe`/`afterProbe` extension hooks. The
  `Report` carries an output surface (`toDict()`/`toJson()`/`writeJson()`) and
  the module exposes a `versionsOutput()` funnel, so a consuming script gets
  structured JSON without scraping console text.
- `cli.mjs` — an interactive REPL (and one-shot container entrypoint) over the
  SDK. Append `--output=PATH` to any command to also save its result: the data
  commands (`versions`/`find`/`test`) write structured JSON; others write text.

Each directory also carries a `package.json`, `Dockerfile`, `Makefile`, and
`.dockerignore`.

`npm/` is the reference implementation (npm is Node's native package manager).

## Quick start (any directory)

```sh
cd npm
make ci                       # syntax-check + smoke
node cli.mjs                  # interactive REPL
node cli.mjs versions left-pad
node main.mjs left-pad --limit 5 --first-only -v
```
