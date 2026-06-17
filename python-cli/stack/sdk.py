#!/usr/bin/env python3
"""Programmatic SDK over ``main.py`` — the single funnel for every caller.

    cli.py    ->  StackVersionsSDK  ->  main.py
    external  ->  StackVersionsSDK  ->  main.py

Both the interactive REPL and any external script drive the tool through this
SDK instead of calling ``main`` directly. The SDK owns session configuration,
lazily provisions the isolated test sandbox, returns *structured* results
(``Report``), and is built to be:

  * **extended** — subclass ``StackVersionsSDK`` and override the ``before_probe``
    / ``after_probe`` hooks (or any method) to inject behaviour; and
  * **driven by args** — ``from_argv`` builds an SDK from a ``main``-style argv
    list, and ``run`` passes raw CLI args straight through to ``main.main``.

External one-liners::

    import sdk
    report = sdk.test("aeson", index_url="https://hackage.haskell.org", limit=5)
    print(report.installable)          # ['2.2.3.0', ...]

    versions = sdk.versions("aeson")   # just list what the registry advertises
    report = sdk.find("aeson")         # stop at the first version that resolves

Object form (hold one per session, mutate ``.config`` freely)::

    s = sdk.StackVersionsSDK(index_url="https://hackage.haskell.org", stack_version="3.1.1")
    s.config.package = "aeson"
    s.test(limit=10)

Extension example::

    class QuietSDK(sdk.StackVersionsSDK):
        def before_probe(self, package, versions):
            return versions[:3]                 # never test more than 3
        def after_probe(self, report):
            report.results = [r for r in report if r["status"] == "success"]
            return report

Raw passthrough (external -> SDK -> main, argv untouched)::

    sdk.StackVersionsSDK().run(["aeson", "--limit", "5", "--first-only"])
"""

from dataclasses import dataclass, field
from typing import List, Optional

import main


# Re-export the engine's constants so callers depend only on the SDK surface.
DEFAULT_STACK_VERSION = main.DEFAULT_STACK_VERSION
ENV_DEFAULTS = main.ENV_DEFAULTS

# Sentinel for "argument not supplied" — distinct from an explicit ``None``,
# which is itself meaningful (index_url=None => use stack's default, no
# --index-url; limit=None => test every version).
_UNSET = object()


class StackVersionsError(RuntimeError):
    """SDK-level failure (e.g. no package set, or no versions to test)."""


@dataclass
class Config:
    """Everything the SDK needs to drive a probe; every field has a default.

    ``index_url`` carries a third state beyond str/None: the ``_UNSET`` sentinel
    means "resolve from the environment" (the default), matching ``main``'s
    ``$STACK_REGISTRY_URL > $HACKAGE_API_URL > hackage`` chain. An explicit
    ``None`` means "use stack's own default" (omit ``--index-url`` entirely).
    """

    package: Optional[str] = None
    index_url: object = _UNSET
    venv_dir: str = ".stack-test-resolve"
    output: str = "installation_report.json"
    stack_version: Optional[str] = DEFAULT_STACK_VERSION  # None/"none" => skip version check
    limit: Optional[int] = None
    verbose: bool = False  # stream full stack output so resolves are debuggable
    env: dict = field(default_factory=dict)  # per-call overrides for ENV_DEFAULTS


@dataclass
class Report:
    """Structured outcome of a resolve-test run (wraps ``main``'s raw dicts)."""

    package: str
    index_url: Optional[str]
    output_path: str
    results: List[dict] = field(default_factory=list)

    @property
    def installable(self) -> List[str]:
        """Versions that resolved cleanly, newest-first."""
        return [r["version"] for r in self.results if r.get("status") == "success"]

    @property
    def failed(self) -> List[str]:
        """Versions that failed to resolve."""
        return [r["version"] for r in self.results if r.get("status") != "success"]

    @property
    def first_installable(self) -> Optional[str]:
        inst = self.installable
        return inst[0] if inst else None

    def __iter__(self):
        return iter(self.results)

    def __len__(self):
        return len(self.results)


class StackVersionsSDK:
    """Programmatic entry point sitting between every caller and ``main``."""

    def __init__(self, config: Optional[Config] = None, **overrides):
        if config is not None and overrides:
            raise TypeError("pass a Config OR keyword overrides, not both")
        self.config = config or Config(**overrides)
        self._sandbox = None  # lazily provisioned test sandbox dir

    # -- construction from CLI args ---------------------------------------

    @classmethod
    def from_argv(cls, argv) -> "StackVersionsSDK":
        """Build an SDK from a ``main``-style argv list (e.g. ``sys.argv[1:]``).

        Mirrors the CLI exactly: an absent ``--index-url`` resolves from the
        environment (``_UNSET``), and ``--stack-version none`` skips the sandbox
        version check.
        """
        ns = main.parse_args(argv)
        stack_version = None if str(ns.stack_version).lower() == "none" else ns.stack_version
        return cls(Config(
            package=ns.package,
            index_url=_UNSET if ns.index_url is None else ns.index_url,
            venv_dir=ns.venv_dir,
            output=ns.output,
            stack_version=stack_version,
            limit=ns.limit,
            verbose=ns.verbose,
        ))

    # -- config resolution -------------------------------------------------

    def resolve_env(self) -> dict:
        """Resolved env cfg (ENV_DEFAULTS < os.environ < ``config.env``)."""
        return main.resolve_env(self.config.env or None)

    def effective_index_url(self) -> Optional[str]:
        """The index URL stack will actually receive (``None`` => stack default)."""
        if self.config.index_url is _UNSET:
            return main.resolve_index_url(None, self.resolve_env())
        return self.config.index_url

    # -- sandbox lifecycle -------------------------------------------------

    def invalidate_venv(self) -> None:
        """Drop the cached sandbox so the next op re-provisions it.

        Call after changing ``config.venv_dir`` or ``config.stack_version``.
        """
        self._sandbox = None

    def ensure_pip(self) -> str:
        """Provision the test sandbox once and return its directory path."""
        if self._sandbox is None:
            sv = self.config.stack_version
            sv = None if (sv is None or str(sv).lower() == "none") else sv
            self._sandbox = main.setup_venv(
                self.config.venv_dir, sv, self.resolve_env(), verbose=self.config.verbose
            )
        return self._sandbox

    # -- core operations ---------------------------------------------------

    def available_versions(self, package=None, limit=_UNSET) -> List[str]:
        """List versions the registry advertises (newest-first), capped by limit."""
        pkg = self._require_package(package)
        versions = main.get_available_versions(
            pkg, self.effective_index_url(), self.resolve_env(),
            verbose=self.config.verbose,
        )
        return self._apply_limit(versions, limit)

    def find(self, package=None) -> Report:
        """Resolve-test until the first version that works; return a ``Report``."""
        return self._probe(package, limit=_UNSET, first_only=True)

    def test(self, package=None, limit=_UNSET) -> Report:
        """Resolve-test versions (newest-first), write the JSON report, return it.

        An explicit ``limit`` overrides ``config.limit`` for this call only;
        ``limit=None`` tests every advertised version.
        """
        return self._probe(package, limit=limit, first_only=False)

    def run(self, argv) -> int:
        """Pass raw CLI args straight through to ``main.main`` (returns exit code)."""
        return main.main(argv)

    # -- extension hooks (override in a subclass) --------------------------

    def before_probe(self, package: str, versions: List[str]) -> List[str]:
        """Hook: inspect/filter the version list before testing. Return the list."""
        return versions

    def after_probe(self, report: Report) -> Report:
        """Hook: post-process the ``Report`` before it is returned."""
        return report

    # -- internals ---------------------------------------------------------

    def _require_package(self, package) -> str:
        pkg = package or self.config.package
        if not pkg:
            raise StackVersionsError("no package set; pass one or set config.package")
        if package:
            self.config.package = package  # an inline package becomes the default
        return pkg

    def _apply_limit(self, versions, limit):
        cap = self.config.limit if limit is _UNSET else limit
        return versions[:cap] if cap is not None else versions

    def _probe(self, package, limit, first_only) -> Report:
        pkg = self._require_package(package)
        index_url = self.effective_index_url()
        cfg = self.resolve_env()

        versions = main.get_available_versions(pkg, index_url, cfg, verbose=self.config.verbose)
        versions = self._apply_limit(versions, limit)
        versions = self.before_probe(pkg, versions)
        if not versions:
            raise StackVersionsError(f"no versions found for {pkg!r}")

        sandbox = self.ensure_pip()
        results = main.test_installations(
            sandbox, pkg, index_url, versions, self.config.output,
            first_only=first_only, cfg=cfg, verbose=self.config.verbose,
        )
        report = Report(
            package=pkg, index_url=index_url,
            output_path=self.config.output, results=results,
        )
        return self.after_probe(report)


# -- module-level convenience funnels (external -> SDK -> main) -----------

def versions(package, **config) -> List[str]:
    """One-shot: list versions a registry advertises for ``package``."""
    return StackVersionsSDK(package=package, **config).available_versions()


def find(package, **config) -> Report:
    """One-shot: resolve-test until the first version that works."""
    return StackVersionsSDK(package=package, **config).find()


def test(package, **config) -> Report:
    """One-shot: resolve-test versions and write a report."""
    return StackVersionsSDK(package=package, **config).test()


def run(argv) -> int:
    """One-shot raw passthrough to ``main.main``."""
    return StackVersionsSDK().run(argv)
