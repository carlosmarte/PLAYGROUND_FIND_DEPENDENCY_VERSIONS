#!/usr/bin/env python3
"""Programmatic SDK over ``main.py`` — the single funnel for every caller.

    cli.py    ->  PuppetVersionsSDK  ->  main.py
    external  ->  PuppetVersionsSDK  ->  main.py

Both the interactive REPL and any external script drive the tool through this
SDK instead of calling ``main`` directly. The SDK owns session configuration,
lazily provisions the isolated sandbox target dir, returns *structured* results
(``Report``), and is built to be:

  * **extended** — subclass ``PuppetVersionsSDK`` and override the
    ``before_probe`` / ``after_probe`` hooks (or any method) to inject
    behaviour; and
  * **driven by args** — ``from_argv`` builds an SDK from a ``main``-style argv
    list, and ``run`` passes raw CLI args straight through to ``main.main``.

External one-liners::

    import sdk
    report = sdk.test("puppetlabs-stdlib", forge_server="https://forgeapi.puppet.com", limit=5)
    print(report.installable)          # ['9.6.0', ...]

    versions = sdk.versions("puppetlabs-stdlib")  # just list what the Forge advertises
    report = sdk.find("puppetlabs-stdlib")        # stop at the first that installs

Object form (hold one per session, mutate ``.config`` freely)::

    s = sdk.PuppetVersionsSDK(forge_server="https://forgeapi.puppet.com", puppet_version="8.10.0")
    s.config.package = "puppetlabs-stdlib"
    s.test(limit=10)

Extension example::

    class QuietSDK(sdk.PuppetVersionsSDK):
        def before_probe(self, package, versions):
            return versions[:3]                 # never test more than 3
        def after_probe(self, report):
            report.results = [r for r in report if r["status"] == "success"]
            return report

Raw passthrough (external -> SDK -> main, argv untouched)::

    sdk.PuppetVersionsSDK().run(["puppetlabs-stdlib", "--limit", "5", "--first-only"])
"""

from dataclasses import dataclass, field
from typing import List, Optional

import main


# Re-export the engine's constants so callers depend only on the SDK surface.
DEFAULT_PUPPET_VERSION = main.DEFAULT_PUPPET_VERSION
ENV_DEFAULTS = main.ENV_DEFAULTS

# Sentinel for "argument not supplied" — distinct from an explicit ``None``,
# which is itself meaningful (forge_server=None => use puppet's default;
# limit=None => test every version).
_UNSET = object()


class PuppetVersionsError(RuntimeError):
    """SDK-level failure (e.g. no package set, or no versions to test)."""


@dataclass
class Config:
    """Everything the SDK needs to drive a probe; every field has a default.

    ``forge_server`` carries a third state beyond str/None: the ``_UNSET``
    sentinel means "resolve from the environment" (the default), matching
    ``main``'s ``$PUPPET_FORGE_SERVER > $PUPPET_REGISTRY_URL > forgeapi.puppet.com``
    chain. An explicit ``None`` means "use puppet's own default" (omit the
    ``--module_repository`` override entirely).
    """

    package: Optional[str] = None
    forge_server: object = _UNSET
    venv_dir: str = ".venv-test-install"
    output: str = "installation_report.json"
    puppet_version: Optional[str] = DEFAULT_PUPPET_VERSION  # None/"none" => whatever is on PATH
    limit: Optional[int] = None
    verbose: bool = False  # stream full puppet output so installs are debuggable
    env: dict = field(default_factory=dict)  # per-call overrides for ENV_DEFAULTS


@dataclass
class Report:
    """Structured outcome of an install-test run (wraps ``main``'s raw dicts)."""

    package: str
    forge_server: Optional[str]
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


class PuppetVersionsSDK:
    """Programmatic entry point sitting between every caller and ``main``."""

    def __init__(self, config: Optional[Config] = None, **overrides):
        if config is not None and overrides:
            raise TypeError("pass a Config OR keyword overrides, not both")
        self.config = config or Config(**overrides)
        self._target_dir = None  # lazily provisioned sandbox target dir

    # -- construction from CLI args ---------------------------------------

    @classmethod
    def from_argv(cls, argv) -> "PuppetVersionsSDK":
        """Build an SDK from a ``main``-style argv list (e.g. ``sys.argv[1:]``).

        Mirrors the CLI exactly: an absent ``--forge-server`` resolves from the
        environment (``_UNSET``), and ``--puppet-version none`` uses whatever
        puppet is on PATH.
        """
        ns = main.parse_args(argv)
        puppet_version = None if str(ns.puppet_version).lower() == "none" else ns.puppet_version
        return cls(Config(
            package=ns.package,
            forge_server=_UNSET if ns.forge_server is None else ns.forge_server,
            venv_dir=ns.venv_dir,
            output=ns.output,
            puppet_version=puppet_version,
            limit=ns.limit,
            verbose=ns.verbose,
        ))

    # -- config resolution -------------------------------------------------

    def resolve_env(self) -> dict:
        """Resolved env cfg (ENV_DEFAULTS < os.environ < ``config.env``)."""
        return main.resolve_env(self.config.env or None)

    def effective_forge_server(self) -> Optional[str]:
        """The Forge server puppet will actually receive (``None`` => default)."""
        if self.config.forge_server is _UNSET:
            return main.resolve_forge_server(None, self.resolve_env())
        return self.config.forge_server

    # -- sandbox lifecycle -------------------------------------------------

    def invalidate_venv(self) -> None:
        """Drop the cached sandbox target dir so the next op re-provisions it.

        Call after changing ``config.venv_dir`` or ``config.puppet_version``.
        """
        self._target_dir = None

    def ensure_pip(self) -> str:
        """Provision the sandbox target dir once and return its path."""
        if self._target_dir is None:
            pv = self.config.puppet_version
            pv = None if (pv is None or str(pv).lower() == "none") else pv
            self._target_dir = main.setup_venv(
                self.config.venv_dir, pv, self.resolve_env(), verbose=self.config.verbose
            )
        return self._target_dir

    # -- core operations ---------------------------------------------------

    def available_versions(self, package=None, limit=_UNSET) -> List[str]:
        """List versions the Forge advertises (newest-first), capped by limit."""
        pkg = self._require_package(package)
        versions = main.get_available_versions(
            pkg, self.effective_forge_server(), self.resolve_env(),
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
            raise PuppetVersionsError("no package set; pass one or set config.package")
        if package:
            self.config.package = package  # an inline package becomes the default
        return pkg

    def _apply_limit(self, versions, limit):
        cap = self.config.limit if limit is _UNSET else limit
        return versions[:cap] if cap is not None else versions

    def _probe(self, package, limit, first_only) -> Report:
        pkg = self._require_package(package)
        forge_server = self.effective_forge_server()
        cfg = self.resolve_env()

        versions = main.get_available_versions(pkg, forge_server, cfg, verbose=self.config.verbose)
        versions = self._apply_limit(versions, limit)
        versions = self.before_probe(pkg, versions)
        if not versions:
            raise PuppetVersionsError(f"no versions found for {pkg!r}")

        target_dir = self.ensure_pip()
        results = main.test_installations(
            target_dir, pkg, forge_server, versions, self.config.output,
            first_only=first_only, cfg=cfg, verbose=self.config.verbose,
        )
        report = Report(
            package=pkg, forge_server=forge_server,
            output_path=self.config.output, results=results,
        )
        return self.after_probe(report)


# -- module-level convenience funnels (external -> SDK -> main) -----------

def versions(package, **config) -> List[str]:
    """One-shot: list versions the Puppet Forge advertises for ``package``."""
    return PuppetVersionsSDK(package=package, **config).available_versions()


def find(package, **config) -> Report:
    """One-shot: install-test until the first version that works."""
    return PuppetVersionsSDK(package=package, **config).find()


def test(package, **config) -> Report:
    """One-shot: install-test versions and write a report."""
    return PuppetVersionsSDK(package=package, **config).test()


def run(argv) -> int:
    """One-shot raw passthrough to ``main.main``."""
    return PuppetVersionsSDK().run(argv)
