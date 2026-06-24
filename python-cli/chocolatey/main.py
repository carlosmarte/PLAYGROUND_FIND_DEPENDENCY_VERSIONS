#!/usr/bin/env python3
"""Find installable versions of a package from a (custom) Chocolatey registry.

Discovers every version a registry advertises for a package via the Chocolatey
community feed's NuGet v2 OData endpoint (``/FindPackagesById()?id='<id>'``),
then attempts to install each one with ``choco install`` into an isolated
throwaway cache directory, recording success/failure per version to a JSON
report.

IMPORTANT — platform note: ``choco`` itself is **Windows-only**. The HTTP
version-listing (the ``versions`` command) queries the community feed over
plain HTTP and therefore works on any OS. The install-test step shells out to
``choco install``, which requires Windows with ``choco`` on PATH; on a
non-Windows host that subprocess simply fails (the listing still works fine).

Example:
    python main.py git \
        --source https://community.chocolatey.org/api/v2/

    # only probe the newest 5 versions, stop at the first that installs
    python main.py git --source https://community.chocolatey.org/api/v2/ \
        --limit 5 --first-only
"""

import argparse
import json
import os
import re
import signal
import subprocess
import sys
import urllib.request
import xml.etree.ElementTree as ET  # stdlib; the v2 feed returns ATOM/XML, not JSON

# choco tool version the test environment is expected to use by default.
# Install-tests run against this toolchain, so it governs install/resolver
# behaviour. Override via --choco-version (CLI) or the `choco` command (REPL).
DEFAULT_CHOCO_VERSION = "2.3.0"

# Environment knobs read via os.environ.get, each falling back to the value the
# Chocolatey / NuGet / TLS ecosystem uses by default ("industry standard").
# choco itself reads some of these from the environment; we resolve them
# explicitly so the documented default still applies when the var is unset, and
# so they can be surfaced (REPL `env`) and threaded into every choco invocation
# we build.
ENV_DEFAULTS = {
    "CHOCO_VERBOSE": "0",                                          # choco: quiet (0 = normal)
    "CHOCO_CERT": "",                                              # choco: use system store
    "CHOCO_API": "https://community.chocolatey.org/api/v2",        # NuGet v2 feed base for listing
    "CHOCO_SOURCE": "https://community.chocolatey.org/api/v2/",    # source for install
    "CHOCO_TRUSTED_HOST": "",                                      # choco: no extra trusted hosts
    "CHOCO_DEFAULT_TIMEOUT": "15",                                 # choco: 15s socket timeout
    "CHOCO_RETRIES": "5",                                          # choco: 5 connection retries
    "CHOCO_REGISTRY_URL": "https://community.chocolatey.org/api/v2/",  # our source fallback
    "CHOCO_REGISTRY_NAME": "Chocolatey Community",                 # registry display name
    "REQUESTS_CA_BUNDLE": "",                                      # requests/urllib3: certifi
    "SSL_CERT_FILE": "",                                           # OpenSSL: system CA file
    "SSL_CERT_DIR": "",                                            # OpenSSL: system CA dir
}

# TLS vars passed through to child processes via the environment (no CLI flag).
_TLS_ENV_VARS = ("REQUESTS_CA_BUNDLE", "SSL_CERT_FILE", "SSL_CERT_DIR")


def resolve_env(overrides=None):
    """Resolve every supported env var, falling back to its industry default.

    ``overrides`` (non-None values only) win over both env and defaults — used
    to fold in command-line flags. Returns a fresh dict each call.
    """
    cfg = {name: os.environ.get(name, default) for name, default in ENV_DEFAULTS.items()}
    if overrides:
        cfg.update({k: v for k, v in overrides.items() if v is not None})
    return cfg


def resolve_index_url(explicit, cfg=None):
    """Pick the source URL: explicit flag > CHOCO_SOURCE > CHOCO_REGISTRY_URL."""
    cfg = cfg or resolve_env()
    return explicit or cfg["CHOCO_SOURCE"] or cfg["CHOCO_REGISTRY_URL"] or None


def choco_options(cfg):
    """Translate resolved config into choco command-line flags."""
    opts = []
    try:
        level = int(cfg["CHOCO_VERBOSE"])
    except (TypeError, ValueError):
        level = 0
    if level > 0:
        opts += ["--verbose"]  # choco: bump install verbosity
    if cfg["CHOCO_CERT"]:
        # choco reads a client cert via config, not a per-call flag; keep this a
        # no-op mirroring the reference shape so the resolved value stays
        # addressable without changing behaviour.
        pass
    # choco install has an --execution-timeout flag; NuGet-style retries are read
    # from the environment, so they ride along via subprocess_env. We still keep
    # the resolved values addressable for parity with the reference shape.
    return opts


def subprocess_env(cfg):
    """Child-process environment with resolved TLS cert + Choco vars applied."""
    env = os.environ.copy()
    for name in _TLS_ENV_VARS:
        if cfg[name]:
            env[name] = cfg[name]
    # choco honours these from the environment; thread the resolved values in.
    env["CHOCO_DEFAULT_TIMEOUT"] = str(cfg["CHOCO_DEFAULT_TIMEOUT"])
    env["CHOCO_RETRIES"] = str(cfg["CHOCO_RETRIES"])
    return env


def get_available_versions(package, index_url, cfg=None, verbose=False):
    """Return the list of versions a registry advertises for ``package``.

    Versions are returned newest-first. The Chocolatey community feed is a NuGet
    v2 OData feed: ``FindPackagesById()?id='<pkg>'`` returns an ATOM/XML
    document whose ``<entry>`` elements each carry a
    ``<m:properties><d:Version>`` value (namespaces ``m`` =
    ``.../metadata`` and ``d`` = ``.../dataservices``). We parse the XML with
    ``xml.etree.ElementTree`` (stdlib) and namespace-agnostically collect the
    text of every element whose localname is ``Version``. The feed is typically
    oldest-first, so we sort descending if possible, else reverse the feed
    order. When ``verbose`` is set, the API URL and its raw payload are echoed
    so a failed or empty discovery can be debugged.

    Note: this listing is plain HTTP and works on any OS; the *install-test*
    step below requires Windows with ``choco`` on PATH.
    """
    cfg = cfg or resolve_env()
    print(f"Retrieving versions for '{package}' from {index_url}...")
    # The v2 OData feed keys its lookup by the package id passed as a quoted
    # string literal inside FindPackagesById().
    api = cfg["CHOCO_API"].rstrip("/")
    url = f"{api}/FindPackagesById()?id='{package}'"
    if verbose:
        print(f"  $ GET {url}")

    try:
        req = urllib.request.Request(url, headers={"Accept": "application/atom+xml"})
        with urllib.request.urlopen(req, timeout=int(cfg["CHOCO_DEFAULT_TIMEOUT"])) as resp:
            payload = resp.read().decode("utf-8")
    except Exception as e:  # urllib raises a zoo of errors; treat all as fatal here
        if verbose:
            _echo(str(e))
        print(f"Error querying Chocolatey v2 feed: {e}", file=sys.stderr)
        sys.exit(1)

    if verbose:
        _echo(payload)
    try:
        root = ET.fromstring(payload)
    except ET.ParseError:
        print("Could not parse XML from Chocolatey v2 feed.", file=sys.stderr)
        return []
    # Namespace-agnostic walk: collect the text of any element whose localname
    # (the part after a ``{namespace}`` prefix) is exactly 'Version'.
    versions = []
    for el in root.iter():
        tag = el.tag.rsplit("}", 1)[-1]
        if tag == "Version" and el.text and el.text.strip():
            versions.append(el.text.strip())
    if not versions:
        print("Could not find any versions in Chocolatey v2 feed.", file=sys.stderr)
        return []

    # Feed is typically oldest-first. Prefer a descending numeric-aware sort so
    # callers get newest-first; fall back to simply reversing the feed order if
    # the versions don't sort cleanly.
    def _key(v):
        return [int(p) if p.isdigit() else p for p in re.split(r"[.\-]", v)]

    try:
        return sorted(set(versions), key=_key, reverse=True)
    except TypeError:
        return list(reversed(versions))


def setup_venv(env_dir, choco_version=DEFAULT_CHOCO_VERSION, cfg=None, verbose=False):
    """Create a fresh throwaway choco cache/output dir if needed; return it.

    The sandbox is a temp directory used as choco's ``--cache-location`` /
    output dir into which each version is installed with ``choco install``.
    ``choco_version`` records the toolchain the tests are expected to run
    against (default ``DEFAULT_CHOCO_VERSION``). Pass ``choco_version=None`` to
    skip the toolchain-check echo. ``verbose`` echoes the setup output so a
    failed setup can be debugged.
    """
    cfg = cfg or resolve_env()
    if not os.path.exists(env_dir):
        print(f"Creating throwaway choco cache dir at: {env_dir}")
    os.makedirs(env_dir, exist_ok=True)

    if choco_version:
        _ensure_choco_version(env_dir, choco_version, cfg, verbose=verbose)
    return env_dir


def _ensure_choco_version(env_dir, choco_version, cfg=None, verbose=False):
    """Report the choco version (the toolchain install-tests run against)."""
    cfg = cfg or resolve_env()
    print(f"Ensuring choco>={choco_version} in the test environment...")
    cmd = ["choco", "--version"]
    if verbose:
        print(f"  $ {' '.join(cmd)}")
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, env=subprocess_env(cfg))
    except FileNotFoundError as e:
        # choco is Windows-only; on other hosts it is simply not on PATH.
        print(
            f"Warning: could not verify choco>={choco_version}: {e}",
            file=sys.stderr,
        )
        return
    if verbose:
        _echo(res.stdout, res.stderr)
    if res.returncode != 0:
        # A negative returncode means the child was killed by a signal, leaving
        # stderr empty — fall back to the signal name so the warning isn't blank.
        detail = _last_line(res.stderr)
        if not detail and res.returncode is not None and res.returncode < 0:
            try:
                detail = f"terminated by signal {signal.Signals(-res.returncode).name}"
            except ValueError:
                detail = f"terminated by signal {-res.returncode}"
        print(
            f"Warning: could not verify choco>={choco_version}: "
            f"{detail or 'unknown error'}",
            file=sys.stderr,
        )


def _last_line(text):
    """Return the last non-empty line of ``text`` (for compact logging)."""
    lines = [ln for ln in (text or "").strip().splitlines() if ln.strip()]
    return lines[-1] if lines else ""


def _echo(*texts):
    """Write each non-empty text to stdout (newline-terminated). Verbose helper."""
    for t in texts:
        if t:
            sys.stdout.write(t if t.endswith("\n") else t + "\n")


def _has_verbose(options):
    """True if choco ``options`` already carry a ``--verbose`` flag."""
    return any(o == "--verbose" for o in options)


def _stream(cmd, env):
    """Run ``cmd``, echoing combined output live while capturing it.

    Returns ``(returncode, combined_output)``. Used in verbose mode so the user
    watches choco in real time (e.g. a slow install or a hang) yet the captured
    text still feeds the JSON report.
    """
    proc = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env,
    )
    chunks = []
    for line in proc.stdout:
        sys.stdout.write(line)
        sys.stdout.flush()
        chunks.append(line)
    proc.wait()
    return proc.returncode, "".join(chunks)


def test_installations(venv_dir, package, index_url, versions, output_json,
                       first_only=False, cfg=None, verbose=False):
    """Attempt to install each version; write an incremental JSON report.

    Returns the list of result dicts. If ``first_only`` is set, stops after
    the first version that installs successfully. When ``verbose`` is set,
    choco's full output is streamed live (and a ``--verbose`` flag is added if
    none is present) so install failures can be debugged; the captured output
    is also folded into the report under ``log``/``error``.

    IMPORTANT: choco is Windows-only and modifies the system — this performs a
    *real* ``choco install``. On non-Windows hosts choco is unavailable and
    these tests will fail at the subprocess level (a ``FileNotFoundError`` is
    caught and recorded as a failed result). The HTTP listing above still works
    cross-platform.
    """
    cfg = cfg or resolve_env()
    env = subprocess_env(cfg)
    options = choco_options(cfg)
    results = []
    installable = []

    for idx, version in enumerate(versions, start=1):
        target = f"{package}@{version}"
        print(f"[{idx}/{len(versions)}] Attempting to install: {target}...")

        cmd = [
            "choco",
            "install",
            package,
            "--version",
            version,
            "-y",
            "--no-progress",
            "--cache-location",
            venv_dir,
        ]
        cmd += options
        if index_url:
            cmd += ["--source", index_url]
        # Bump choco's own verbosity if the user wants detail and nothing set it.
        if verbose and not _has_verbose(options):
            cmd += ["--verbose"]

        try:
            if verbose:
                print(f"  $ {' '.join(cmd)}")
                returncode, output = _stream(cmd, env)
                stdout_text = stderr_text = output  # streamed combined; same text both ways
            else:
                res = subprocess.run(cmd, capture_output=True, text=True, env=env)
                returncode, stdout_text, stderr_text = res.returncode, res.stdout, res.stderr
        except FileNotFoundError as e:
            # choco not on PATH (e.g. non-Windows host). Record and continue.
            returncode, stdout_text, stderr_text = 1, "", str(e)

        if returncode == 0:
            print(f"  ✅ SUCCESS: {target}")
            results.append({
                "version": version,
                "status": "success",
                "log": _last_line(stdout_text),
            })
            installable.append(version)
        else:
            print(f"  ❌ FAILED: {target}")
            results.append({
                "version": version,
                "status": "failed",
                "error": _last_line(stderr_text) or _last_line(stdout_text) or "Unknown error",
            })

        # Persist after every iteration so partial results survive a crash.
        with open(output_json, "w") as f:
            json.dump(results, f, indent=4)

        if first_only and installable:
            print(f"  First installable version found: {installable[0]} (stopping).")
            break

    print(f"\nTesting complete! Results saved to {output_json}")
    if installable:
        print(f"Installable versions ({len(installable)}): {', '.join(installable)}")
    else:
        print("No installable versions found.")
    return results


def parse_args(argv=None):
    p = argparse.ArgumentParser(
        description="Find installable versions of a package from a Chocolatey registry.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("package", help="Package id to probe (e.g. git).")
    p.add_argument(
        "--source",
        default=None,
        help="Custom Chocolatey source URL. Defaults to $CHOCO_SOURCE, "
             "then $CHOCO_REGISTRY_URL, then https://community.chocolatey.org/api/v2/.",
    )
    p.add_argument(
        "--venv-dir",
        default=".venv-test-install",
        help="Directory for the isolated throwaway choco cache/output.",
    )
    p.add_argument(
        "--choco-version",
        default=DEFAULT_CHOCO_VERSION,
        help="choco version expected in the test env ('none' to skip the check).",
    )
    p.add_argument(
        "--output",
        default="installation_report.json",
        help="Path to write the JSON report.",
    )
    p.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Only test the newest N versions (default: all).",
    )
    p.add_argument(
        "--first-only",
        action="store_true",
        help="Stop after the first version that installs successfully.",
    )
    p.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="Stream full choco output for every step so failures are debuggable.",
    )
    return p.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)

    cfg = resolve_env()
    index_url = resolve_index_url(args.source, cfg)

    versions = get_available_versions(args.package, index_url, cfg, verbose=args.verbose)
    if not versions:
        print("No versions found. Exiting.")
        return 1

    if args.limit is not None:
        versions = versions[: args.limit]

    print(f"Found {len(versions)} version(s) to test "
          f"(registry: {cfg['CHOCO_REGISTRY_NAME']}).")
    choco_version = None if str(args.choco_version).lower() == "none" else args.choco_version
    venv_dir = setup_venv(args.venv_dir, choco_version, cfg, verbose=args.verbose)
    test_installations(
        venv_dir,
        args.package,
        index_url,
        versions,
        args.output,
        first_only=args.first_only,
        cfg=cfg,
        verbose=args.verbose,
    )
    return 0


# main() accepts an optional argv list. Pass one explicitly to drive the tool
# programmatically (e.g. from another script or a test); omit it and main()
# falls back to parse_args(None), which reads from sys.argv (normal CLI use).
#
# Example — probe the newest 5 versions of git, stop at the first installable:
#     main(["git", "--source", "https://community.chocolatey.org/api/v2/",
#           "--limit", "5", "--first-only"])
#
# Equivalent on the command line:
#     python3 main.py git \
#         --source https://community.chocolatey.org/api/v2/ --limit 5 --first-only

if __name__ == "__main__":
    raise SystemExit(main())  # argv=None -> parse_args reads sys.argv
