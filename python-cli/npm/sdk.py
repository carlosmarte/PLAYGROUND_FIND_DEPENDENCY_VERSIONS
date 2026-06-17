#!/usr/bin/env python3
"""Programmatic SDK over ``main.py`` — the single funnel for every caller.

    cli.py    ->  NpmVersionsSDK  ->  main.py
    external  ->  NpmVersionsSDK  ->  main.py

Both the interactive REPL and any external script drive the tool through this
SDK instead of calling ``main`` directly. The SDK owns session configuration,
lazily provisions the isolated test install prefix, returns *structured* results
(``Report``), and is built to be:

  * **extended** — subclass ``NpmVersionsSDK`` and override the ``before_probe``
    / ``after_probe`` hooks (or any method) to inject behaviour; and
  * **driven by args** — ``from_argv`` builds an SDK from a ``main``-style argv
    list, and ``run`` passes raw CLI args straight through to ``main.main``.

External one-liners::

    import sdk
    report = sdk.test("left-pad", index_url="https://reg", limit=5)
    print(report.installable)          # ['1.3.0', ...]

    versions = sdk.versions("left-pad")  # just list what the registry advertises
    report = sdk.find("left-pad")        # stop at the first version that installs

Object form (hold one per session, mutate ``.config`` freely)::

    s = sdk.NpmVersionsSDK(index_url="https://reg", npm_version="10.9.2")
    s.config.package = "left-pad"
    s.test(limit=10)

Extension example::

    class QuietSDK(sdk.NpmVersionsSDK):
        def before_probe(self, package, versions):
            return versions[:3]                 # never test more than 3
        def after_probe(self, report):
            report.results = [r for r in report if r["status"] == "success"]
            return report

Raw passthrough (external -> SDK -> main, argv untouched)::

    sdk.NpmVersionsSDK().run(["left-pad", "--limit", "5", "--first-only"])
"""

from dataclasses import dataclass, field
from typing import List, Optional

import main


# Re-export the engine's constants so callers depend only on the SDK surface.
DEFAULT_NPM_VERSION = main.DEFAULT_NPM_VERSION
ENV_DEFAULTS = main.ENV_DEFAULTS

# Sentinel for "argument not supplied" — distinct from an explicit ``None``,
# which is itself meaningful (index_url=None => use npm's default, no
# --registry; limit=None => test every version).
_UNSET = object()


class NpmVersionsError(RuntimeError):
    """SDK-level failure (e.g. no package set, or no versions to test)."""


@dataclass
class Config:
    """Everything the SDK needs to drive a probe; every field has a default.

    ``index_url`` carries a third state beyond str/None: the ``_UNSET`` sentinel
    means "resolve from the environment" (the default), matching ``main``'s
    ``$NPM_CONFIG_REGISTRY > $NODE_REGISTRY_URL > registry.npmjs.org`` chain. An
    explicit ``None`` means "use npm's own default" (omit ``--registry``
    entirely).
    """

    package: Optional[str] = None
    index_url: object = _UNSET
    venv_dir: str = ".npm-test-install"
    output: str = "installation_report.json"
    npm_version: Optional[str] = DEFAULT_NPM_VERSION  # None/"none" => keep npm on PATH
    limit: Optional[int] = None
    verbose: bool = False  # stream full npm output so installs are debuggable
    env: dict = field(default_factory=dict)  # per-call overrides for ENV_DEFAULTS


@dataclass
class Report:
    """Structured outcome of an install-test run (wraps ``main``'s raw dicts)."""

    package: str
    index_url: Optional[str]
    output_path: str
    results: List[dict] = field(default_factory=list)

    @property
    def installable(self) -> List[str]:
        """Versions that installed cleanly, newest-first."""
        return [r["version"] for r in self.results if r.get("status") == "success"]

    @property
    def failed(self) -> List[str]:
        """Versions that failed to install."""
        return [r["version"] for r in self.results if r.get("status") != "success"]

    @property
    def first_installable(self) -> Optional[str]:
        inst = self.installable
        return inst[0] if inst else None

    def __iter__(self):
        return iter(self.results)

    def __len__(self):
        return len(self.results)


class NpmVersionsSDK:
    """Programmatic entry point sitting between every caller and ``main``."""

    def __init__(self, config: Optional[Config] = None, **overrides):
        if config is not None and overrides:
            raise TypeError("pass a Config OR keyword overrides, not both")
        self.config = config or Config(**overrides)
        self._pip_path = None  # lazily provisioned test install-prefix dir

    # -- construction from CLI args ---------------------------------------

    @classmethod
    def from_argv(cls, argv) -> "NpmVersionsSDK":
        """Build an SDK from a ``main``-style argv list (e.g. ``sys.argv[1:]``).

        Mirrors the CLI exactly: an absent ``--registry`` resolves from the
        environment (``_UNSET``), and ``--npm-version none`` keeps the npm on
        PATH.
        """
        ns = main.parse_args(argv)
        npm_version = None if str(ns.npm_version).lower() == "none" else ns.npm_version
        return cls(Config(
            package=ns.package,
            index_url=_UNSET if ns.index_url is None else ns.index_url,
            venv_dir=ns.venv_dir,
            output=ns.output,
            npm_version=npm_version,
            limit=ns.limit,
            verbose=ns.verbose,
        ))

    # -- config resolution -------------------------------------------------

    def resolve_env(self) -> dict:
        """Resolved env cfg (ENV_DEFAULTS < os.environ < ``config.env``)."""
        return main.resolve_env(self.config.env or None)

    def effective_index_url(self) -> Optional[str]:
        """The registry URL npm will actually receive (``None`` => npm default)."""
        if self.config.index_url is _UNSET:
            return main.resolve_index_url(None, self.resolve_env())
        return self.config.index_url

    # -- venv lifecycle ----------------------------------------------------

    def invalidate_venv(self) -> None:
        """Drop the cached install prefix so the next op re-provisions it.

        Call after changing ``config.venv_dir`` or ``config.npm_version``.
        """
        self._pip_path = None

    def ensure_pip(self) -> str:
        """Provision the test install prefix once and return its directory path."""
        if self._pip_path is None:
            nv = self.config.npm_version
            nv = None if (nv is None or str(nv).lower() == "none") else nv
            self._pip_path = main.setup_venv(
                self.config.venv_dir, nv, self.resolve_env(), verbose=self.config.verbose
            )
        return self._pip_path

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
        """Install-test until the first version that works; return a ``Report``."""
        return self._probe(package, limit=_UNSET, first_only=True)

    def test(self, package=None, limit=_UNSET) -> Report:
        """Install-test versions (newest-first), write the JSON report, return it.

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
            raise NpmVersionsError("no package set; pass one or set config.package")
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
            raise NpmVersionsError(f"no versions found for {pkg!r}")

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
    """One-shot: list versions a registry advertises for ``package``."""
    return NpmVersionsSDK(package=package, **config).available_versions()


def find(package, **config) -> Report:
    """One-shot: install-test until the first version that works."""
    return NpmVersionsSDK(package=package, **config).find()


def test(package, **config) -> Report:
    """One-shot: install-test versions and write a report."""
    return NpmVersionsSDK(package=package, **config).test()


def run(argv) -> int:
    """One-shot raw passthrough to ``main.main``."""
    return NpmVersionsSDK().run(argv)
