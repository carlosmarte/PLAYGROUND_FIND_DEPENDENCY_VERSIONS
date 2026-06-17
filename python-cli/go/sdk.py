#!/usr/bin/env python3
"""Programmatic SDK over ``main.py`` — the single funnel for every caller.

    cli.py    ->  GoVersionsSDK  ->  main.py
    external  ->  GoVersionsSDK  ->  main.py

Both the interactive REPL and any external script drive the tool through this
SDK instead of calling ``main`` directly. The SDK owns session configuration,
lazily provisions the isolated throwaway test module, returns *structured*
results (``Report``), and is built to be:

  * **extended** — subclass ``GoVersionsSDK`` and override the ``before_probe``
    / ``after_probe`` hooks (or any method) to inject behaviour; and
  * **driven by args** — ``from_argv`` builds an SDK from a ``main``-style argv
    list, and ``run`` passes raw CLI args straight through to ``main.main``.

External one-liners::

    import sdk
    report = sdk.test("github.com/stretchr/testify", index_url="https://proxy", limit=5)
    print(report.installable)          # ['v1.9.0', ...]

    versions = sdk.versions("github.com/stretchr/testify")  # list what the proxy advertises
    report = sdk.find("github.com/stretchr/testify")        # stop at the first that fetches

Object form (hold one per session, mutate ``.config`` freely)::

    s = sdk.GoVersionsSDK(index_url="https://proxy", go_version="1.23.4")
    s.config.package = "github.com/stretchr/testify"
    s.test(limit=10)

Extension example::

    class QuietSDK(sdk.GoVersionsSDK):
        def before_probe(self, package, versions):
            return versions[:3]                 # never test more than 3
        def after_probe(self, report):
            report.results = [r for r in report if r["status"] == "success"]
            return report

Raw passthrough (external -> SDK -> main, argv untouched)::

    sdk.GoVersionsSDK().run(["github.com/stretchr/testify", "--limit", "5", "--first-only"])
"""

from dataclasses import dataclass, field
from typing import List, Optional

import main


# Re-export the engine's constants so callers depend only on the SDK surface.
DEFAULT_GO_VERSION = main.DEFAULT_GO_VERSION
ENV_DEFAULTS = main.ENV_DEFAULTS

# Sentinel for "argument not supplied" — distinct from an explicit ``None``,
# which is itself meaningful (index_url=None => use go's default proxy, no
# --proxy; limit=None => test every version).
_UNSET = object()


class GoVersionsError(RuntimeError):
    """SDK-level failure (e.g. no module set, or no versions to test)."""


@dataclass
class Config:
    """Everything the SDK needs to drive a probe; every field has a default.

    ``index_url`` carries a third state beyond str/None: the ``_UNSET`` sentinel
    means "resolve from the environment" (the default), matching ``main``'s
    ``$GOPROXY > $GO_REGISTRY_URL > proxy.golang.org`` chain. An explicit
    ``None`` means "use go's own default" (omit ``--proxy`` entirely).
    """

    package: Optional[str] = None
    index_url: object = _UNSET
    venv_dir: str = ".venv-test-install"
    output: str = "installation_report.json"
    go_version: Optional[str] = DEFAULT_GO_VERSION  # None/"none" => keep active toolchain
    limit: Optional[int] = None
    verbose: bool = False  # stream full go output so fetches are debuggable
    env: dict = field(default_factory=dict)  # per-call overrides for ENV_DEFAULTS


@dataclass
class Report:
    """Structured outcome of a fetch-test run (wraps ``main``'s raw dicts)."""

    package: str
    index_url: Optional[str]
    output_path: str
    results: List[dict] = field(default_factory=list)

    @property
    def installable(self) -> List[str]:
        """Versions that fetched cleanly, newest-first."""
        return [r["version"] for r in self.results if r.get("status") == "success"]

    @property
    def failed(self) -> List[str]:
        """Versions that failed to fetch."""
        return [r["version"] for r in self.results if r.get("status") != "success"]

    @property
    def first_installable(self) -> Optional[str]:
        inst = self.installable
        return inst[0] if inst else None

    def __iter__(self):
        return iter(self.results)

    def __len__(self):
        return len(self.results)


class GoVersionsSDK:
    """Programmatic entry point sitting between every caller and ``main``."""

    def __init__(self, config: Optional[Config] = None, **overrides):
        if config is not None and overrides:
            raise TypeError("pass a Config OR keyword overrides, not both")
        self.config = config or Config(**overrides)
        self._pip_path = None  # lazily provisioned throwaway module dir

    # -- construction from CLI args ---------------------------------------

    @classmethod
    def from_argv(cls, argv) -> "GoVersionsSDK":
        """Build an SDK from a ``main``-style argv list (e.g. ``sys.argv[1:]``).

        Mirrors the CLI exactly: an absent ``--proxy`` resolves from the
        environment (``_UNSET``), and ``--go-version none`` keeps the active
        go toolchain on PATH.
        """
        ns = main.parse_args(argv)
        go_version = None if str(ns.go_version).lower() == "none" else ns.go_version
        return cls(Config(
            package=ns.package,
            index_url=_UNSET if ns.index_url is None else ns.index_url,
            venv_dir=ns.venv_dir,
            output=ns.output,
            go_version=go_version,
            limit=ns.limit,
            verbose=ns.verbose,
        ))

    # -- config resolution -------------------------------------------------

    def resolve_env(self) -> dict:
        """Resolved env cfg (ENV_DEFAULTS < os.environ < ``config.env``)."""
        return main.resolve_env(self.config.env or None)

    def effective_index_url(self) -> Optional[str]:
        """The proxy URL go will actually receive (``None`` => go default)."""
        if self.config.index_url is _UNSET:
            return main.resolve_index_url(None, self.resolve_env())
        return self.config.index_url

    # -- venv lifecycle ----------------------------------------------------

    def invalidate_venv(self) -> None:
        """Drop the cached module dir so the next op re-provisions it.

        Call after changing ``config.venv_dir`` or ``config.go_version``.
        """
        self._pip_path = None

    def ensure_pip(self) -> str:
        """Provision the throwaway module once and return its directory."""
        if self._pip_path is None:
            gv = self.config.go_version
            gv = None if (gv is None or str(gv).lower() == "none") else gv
            self._pip_path = main.setup_venv(
                self.config.venv_dir, gv, self.resolve_env(), verbose=self.config.verbose
            )
        return self._pip_path

    # -- core operations ---------------------------------------------------

    def available_versions(self, package=None, limit=_UNSET) -> List[str]:
        """List versions the proxy advertises (newest-first), capped by limit."""
        pkg = self._require_package(package)
        versions = main.get_available_versions(
            pkg, self.effective_index_url(), self.resolve_env(),
            verbose=self.config.verbose,
        )
        return self._apply_limit(versions, limit)

    def find(self, package=None) -> Report:
        """Fetch-test until the first version that works; return a ``Report``."""
        return self._probe(package, limit=_UNSET, first_only=True)

    def test(self, package=None, limit=_UNSET) -> Report:
        """Fetch-test versions (newest-first), write the JSON report, return it.

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
            raise GoVersionsError("no module set; pass one or set config.package")
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
            raise GoVersionsError(f"no versions found for {pkg!r}")

        pip_path = self.ensure_pip()
        results = main.test_installations(
            pip_path, pkg, index_url, versions, self.config.output,
            first_only=first_only, cfg=cfg, verbose=self.config.verbose,
        )
        report = Report(
            package=pkg, index_url=index_url,
            output_path=self.config.output, results=results,
        )
        return self.after_probe(report)


# -- module-level convenience funnels (external -> SDK -> main) -----------

def versions(package, **config) -> List[str]:
    """One-shot: list versions a proxy advertises for ``package``."""
    return GoVersionsSDK(package=package, **config).available_versions()


def find(package, **config) -> Report:
    """One-shot: fetch-test until the first version that works."""
    return GoVersionsSDK(package=package, **config).find()


def test(package, **config) -> Report:
    """One-shot: fetch-test versions and write a report."""
    return GoVersionsSDK(package=package, **config).test()


def run(argv) -> int:
    """One-shot raw passthrough to ``main.main``."""
    return GoVersionsSDK().run(argv)
