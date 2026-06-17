# 12 — REPL Over a Config View

## Problem

You want an interactive shell, but you don't want it to become a second
implementation of the tool's logic that drifts from the programmatic API.

## Solution

Build the REPL as a **thin view over the SDK's config object**. The shell:

- holds a reference to one SDK instance and exposes its config as the session
  state (a `cfg` accessor returns `sdk.config`);
- maps each command to *reading or writing a config field*, or to *calling an SDK
  method*;
- contains **no engine logic of its own**.

Each command is small: parse the line, mutate `cfg` or call `sdk.method()`, print
a confirmation. "Show settings" just prints the config. The shell is replaceable
and the SDK can be injected (so an extended SDK reuses the same shell).

## Language-neutral sketch

```
class Repl(CommandLoop):
    constructor(client = new Client()):
        self.sdk = client
    property cfg: return self.sdk.config

    command "source" (arg):  if arg: cfg.sourceUrl = arg;  print(effectiveSource())
    command "limit"  (arg):  cfg.limit = parse(arg);       print(cfg.limit)
    command "run"    (arg):  self.sdk.execute(parse(arg))
    command "show"   (_):    print(cfg fields)
```

Config setters that affect a cached resource also trigger invalidation
(see [08 Lazy Provisioning](08-lazy-provisioning-cache.md)).

## In this project

`cli.py`'s `PipVersionsREPL(cmd.Cmd)`: constructor takes an optional `client`
(injected SDK), `cfg` property returns `self.sdk.config`, and every `do_*`
command reads/writes `cfg` or calls an `sdk.*` method. `do_show`/`do_env` print
state. `do_venv`/`do_pip` call `self.sdk.invalidate_venv()` after mutating.
Command help lives in each method's docstring.

## Portability notes

- Python's `cmd.Cmd` gives `do_<name>` dispatch + docstring help for free;
  equivalents: Node `readline`/`inquirer` loops, Go `bufio.Scanner` + a command
  map, Rust `rustyline`. The pattern (thin view over a shared config + client) is
  framework-independent.
- Inject the client through the constructor so tests and extensions can pass a
  custom/subclassed SDK.
- Related: [01 Layered Funnel](01-layered-funnel-architecture.md),
  [03 Configuration Object](03-configuration-object.md),
  [13 One-Shot Entrypoint](13-oneshot-entrypoint.md).
