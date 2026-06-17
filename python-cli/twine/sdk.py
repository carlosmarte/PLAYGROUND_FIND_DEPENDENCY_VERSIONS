#!/usr/bin/env python3
"""Programmatic SDK over ``main.py`` — the single funnel for every caller.

    cli.py    ->  TwineVersionsSDK  ->  main.py
    external  ->  TwineVersionsSDK  ->  main.py

Both the interactive REPL and any external script drive the tool through this
SDK instead of calling ``main`` directly. The SDK owns session configuration,
lazily provisions the isolated scratch download dir, returns *structured*
results (``Report``), and is built to be:

  * **extended** — subclass ``TwineVersionsSDK`` and override the
    ``before_probe`` / ``after_probe`` hooks (or any method) to inject behaviour;
    and
  * **driven by args** — ``from_argv`` builds an SDK from a ``main``-style argv
    list, and ``run`` passes raw CLI args straight through to ``main.main``.

NOTE: twine is publish-side; this clone repurposes ``twine check`` as a
metadata-validity probe. "installable"/"test" therefore mean "metadata-valid"
here — see ``main.py``'s module docstring.

External one-liners::

    import sdk
    report = sdk.test("numpy", index_url="https://reg/simple", limit=5)
    print(report.installable)          # ['1.26.4', ...]  (metadata-valid)

    versions = sdk.versions("numpy")   # just list what the registry advertises
    report = sdk.find("numpy")         # stop at the first version that validates

Structured output (call from any consuming script — no console scraping)::

    report = sdk.test("numpy")
    report.to_dict()                   # JSON-able dict (summary + per-version)
    report.to_json()                   # -> str
    report.write_json("report.json")   # -> writes the file, returns the path

    sdk.versions_output("numpy")       # {'package', 'index_url', 'count', 'versions'}

Object form (hold one per session, mutate ``.config`` freely)::

    s = sdk.TwineVersionsSDK(index_url="https://reg/simple", twine_version="5.1.1")
    s.config.package = "numpy"
    s.test(limit=10)

Extension example::

    class QuietSDK(sdk.TwineVersionsSDK):
        def before_probe(self, package, versions):
            return versions[:3]                 # never test more than 3
        def after_probe(self, report):
            report.results = [r for r in report if r["status"] == "success"]
            return report

Raw passthrough (external -> SDK -> main, argv untouched)::

    sdk.TwineVersionsSDK().run(["numpy", "--limit", "5", "--first-only"])
"""

import json
from dataclasses import dataclass, field
from typing import List, Optional

import main


# Re-export the engine's constants so callers depend only on the SDK surface.
DEFAULT_TWINE_VERSION = main.DEFAULT_TWINE_VERSION
ENV_DEFAULTS = main.ENV_DEFAULTS

# Sentinel for "argument not supplied" — distinct from an explicit ``None``,
# which is itself meaningful (index_url=None => use the default source, no
# --index-url; limit=None => test every version).
_UNSET = object()


class TwineVersionsError(RuntimeError):
    """SDK-level failure (e.g. no package set, or no versions to test)."""


@dataclass
class Config:
    """Everything the SDK needs to drive a probe; every field has a default.

    ``index_url`` carries a third state beyond str/None: the ``_UNSET`` sentinel
    means "resolve from the environment" (the default), matching ``main``'s
    ``$TWINE_REPOSITORY_URL > $PYTHON_REGISTRY_URL > pypi.org`` chain. An
    explicit ``None`` means "use the default index" (omit ``--index-url``
    entirely).
    """

    package: Optional[str] = None
    index_url: object = _UNSET
    venv_dir: str = ".venv-test-install"
    output: str = "installation_report.json"
    twine_version: Optional[str] = DEFAULT_TWINE_VERSION  # None/"none" => keep installed twine
    limit: Optional[int] = None
    verbose: bool = False  # stream full pip/twine output so checks are debuggable
    env: dict = field(default_factory=dict)  # per-call overrides for ENV_DEFAULTS


@dataclass
class Report:
    """Structured outcome of a metadata-check run (wraps ``main``'s raw dicts)."""

    package: str
    index_url: Optional[str]
    output_path: str
    results: List[dict] = field(default_factory=list)

    @property
    def installable(self) -> List[str]:
        """Versions whose metadata validated cleanly, newest-first."""
        return [r["version"] for r in self.results if r.get("status") == "success"]

    @property
    def failed(self) -> List[str]:
        """Versions that failed metadata validation."""
        return [r["version"] for r in self.results if r.get("status") != "success"]

    @property
    def first_installable(self) -> Optional[str]:
        inst = self.installable
        return inst[0] if inst else None

    # -- output surface (callable from any consuming script) ---------------

    def to_dict(self) -> dict:
        """JSON-able view of this report — the canonical serialized shape.

        Includes the derived ``installable``/``failed``/``first_installable``
        rollups alongside the raw per-version ``results`` so a consumer can read
        a summary without recomputing it.
        """
        return {
            "package": self.package,
            "index_url": self.index_url,
            "output_path": self.output_path,
            "count": len(self.results),
            "installable": self.installable,
            "failed": self.failed,
            "first_installable": self.first_installable,
            "results": self.results,
        }

    def to_json(self, indent: int = 2) -> str:
        """Serialize this report to a JSON string."""
        return json.dumps(self.to_dict(), indent=indent)

    def write_json(self, path: str, indent: int = 2) -> str:
        """Write this report as JSON to ``path``; return the path."""
        with open(path, "w") as fh:
            fh.write(self.to_json(indent=indent) + "\n")
        return path

    def __iter__(self):
        return iter(self.results)

    def __len__(self):
        return len(self.results)


class TwineVersionsSDK:
    """Programmatic entry point sitting between every caller and ``main``."""

    def __init__(self, config: Optional[Config] = None, **overrides):
        if config is not None and overrides:
            raise TypeError("pass a Config OR keyword overrides, not both")
        self.config = config or Config(**overrides)
        self._scratch_dir = None  # lazily provisioned scratch download dir

    # -- construction from CLI args ---------------------------------------

    @classmethod
    def from_argv(cls, argv) -> "TwineVersionsSDK":
        """Build an SDK from a ``main``-style argv list (e.g. ``sys.argv[1:]``).

        Mirrors the CLI exactly: an absent ``--index-url`` resolves from the
        environment (``_UNSET``), and ``--twine-version none`` keeps whatever
        twine is on PATH.
        """
        ns = main.parse_args(argv)
        twine_version = None if str(ns.twine_version).lower() == "none" else ns.twine_version
        return cls(Config(
            package=ns.package,
            index_url=_UNSET if ns.index_url is None else ns.index_url,
            venv_dir=ns.venv_dir,
            output=ns.output,
            twine_version=twine_version,
            limit=ns.limit,
            verbose=ns.verbose,
        ))

    # -- config resolution -------------------------------------------------

    def resolve_env(self) -> dict:
        """Resolved env cfg (ENV_DEFAULTS < os.environ < ``config.env``)."""
        return main.resolve_env(self.config.env or None)

    def effective_index_url(self) -> Optional[str]:
        """The index URL pip will actually receive (``None`` => default index)."""
        if self.config.index_url is _UNSET:
            return main.resolve_index_url(None, self.resolve_env())
        return self.config.index_url

    # -- venv lifecycle ----------------------------------------------------

    def invalidate_venv(self) -> None:
        """Drop the cached scratch dir so the next op re-provisions it.

        Call after changing ``config.venv_dir`` or ``config.twine_version``.
        """
        self._scratch_dir = None

    def ensure_pip(self) -> str:
        """Provision the scratch download dir once and return its path."""
        if self._scratch_dir is None:
            tv = self.config.twine_version
            tv = None if (tv is None or str(tv).lower() == "none") else tv
            self._scratch_dir = main.setup_venv(
                self.config.venv_dir, tv, self.resolve_env(), verbose=self.config.verbose
            )
        return self._scratch_dir

    # -- core operations ---------------------------------------------------

    def available_versions(self, package=None, limit=_UNSET) -> List[str]:
        """List versions the registry advertises (newest-first), capped by limit."""
        pkg = self._require_package(package)
        versions = main.get_available_versions(
            pkg, self.effective_index_url(), self.resolve_env(),
            verbose=self.config.verbose,
        )
        return self._apply_limit(versions, limit)

    def versions_output(self, package=None, limit=_UNSET) -> dict:
        """JSON-able envelope for the advertised version list.

        The structured counterpart to ``available_versions`` (which returns the
        bare list): wraps it with the package, the effective index URL, and a
        count so a consumer — or the REPL's ``--output`` flag — can serialize a
        ``versions`` query straight to JSON.
        """
        found = self.available_versions(package, limit=limit)
        return {
            "package": self.config.package,
            "index_url": self.effective_index_url(),
            "count": len(found),
            "versions": found,
        }

    def find(self, package=None) -> Report:
        """Check until the first version whose metadata validates; return a ``Report``."""
        return self._probe(package, limit=_UNSET, first_only=True)

    def test(self, package=None, limit=_UNSET) -> Report:
        """Metadata-check versions (newest-first), write the JSON report, return it.

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
            raise TwineVersionsError("no package set; pass one or set config.package")
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
            raise TwineVersionsError(f"no versions found for {pkg!r}")

        scratch_dir = self.ensure_pip()
        results = main.test_installations(
            scratch_dir, pkg, index_url, versions, self.config.output,
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
    return TwineVersionsSDK(package=package, **config).available_versions()


def versions_output(package, **config) -> dict:
    """One-shot: JSON-able envelope of the versions a registry advertises."""
    return TwineVersionsSDK(package=package, **config).versions_output()


def find(package, **config) -> Report:
    """One-shot: check until the first version whose metadata validates."""
    return TwineVersionsSDK(package=package, **config).find()


def test(package, **config) -> Report:
    """One-shot: metadata-check versions and write a report."""
    return TwineVersionsSDK(package=package, **config).test()


def run(argv) -> int:
    """One-shot raw passthrough to ``main.main``."""
    return TwineVersionsSDK().run(argv)
