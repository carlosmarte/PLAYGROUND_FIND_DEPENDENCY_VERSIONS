#!/usr/bin/env python3
"""Find installable versions of a package from a (custom) package registry.

Discovers every version a registry advertises for a package via
``uv pip index versions``, then attempts to install each one in an isolated
``uv venv`` sandbox, recording success/failure per version to a JSON report.
When the ``uv pip index versions`` command yields nothing, discovery falls back
to the PyPI simple/JSON API over stdlib ``urllib``.

Example:
    python main.py numpy \
        --index-url https://my-registry.example.com/simple

    # only probe the newest 5 versions, stop at the first that installs
    python main.py numpy --index-url https://reg/simple \
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

# uv version the test environment is pinned to by default. Install-tests run
# against this uv, so it governs resolver behaviour. Override via --uv-version
# (CLI) or the `uv` command (REPL).
DEFAULT_UV_VERSION = "0.4.18"

# Environment knobs read via os.environ.get, each falling back to the value the
# Python packaging / TLS ecosystem uses by default ("industry standard"). uv
# itself auto-reads UV_* vars from the environment; we resolve them explicitly
# so the documented default still applies when the var is unset, and so they can
# be surfaced (REPL `env`) and threaded into every uv invocation we build.
ENV_DEFAULTS = {
    "UV_VERBOSE": "0",                               # uv: quiet (0 = no -v)
    "UV_NATIVE_TLS": "",                             # uv: "" => use built-in TLS store
    "UV_INDEX_URL": "https://pypi.org/simple",       # uv: PEP 503 simple index
    "UV_EXTRA_INDEX_URL": "",                        # uv: extra simple indexes
    "UV_HTTP_TIMEOUT": "15",                         # uv: 15s socket timeout
    "UV_CONCURRENT_DOWNLOADS": "5",                  # uv: parallel download slots
    "PYTHON_REGISTRY_URL": "https://pypi.org/simple",  # our index-url fallback
    "PYTHON_REGISTRY_NAME": "PyPI",                  # registry display name
    "REQUESTS_CA_BUNDLE": "",                        # requests/urllib3: certifi
    "SSL_CERT_FILE": "",                             # OpenSSL: system CA file
    "SSL_CERT_DIR": "",                              # OpenSSL: system CA dir
}

# JSON metadata base used for the version-discovery fallback (stdlib urllib).
PYPI_JSON_BASE = "https://pypi.org/pypi"

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
    """Pick the index URL: explicit flag > UV_INDEX_URL > PYTHON_REGISTRY_URL."""
    cfg = cfg or resolve_env()
    return explicit or cfg["UV_INDEX_URL"] or cfg["PYTHON_REGISTRY_URL"] or None


def uv_options(cfg):
    """Translate resolved config into uv command-line flags."""
    opts = []
    try:
        level = int(cfg["UV_VERBOSE"])
    except (TypeError, ValueError):
        level = 0
    if level > 0:
        opts.append("-" + "v" * level)  # -v / -vv / -vvv ...
    if cfg["UV_NATIVE_TLS"]:
        opts.append("--native-tls")
    return opts


def subprocess_env(cfg):
    """Child-process environment with resolved TLS cert vars applied."""
    env = os.environ.copy()
    for name in _TLS_ENV_VARS:
        if cfg[name]:
            env[name] = cfg[name]
    env["UV_HTTP_TIMEOUT"] = str(cfg["UV_HTTP_TIMEOUT"])
    return env


def get_available_versions(package, index_url, cfg=None, verbose=False):
    """Return the list of versions a registry advertises for ``package``.

    Versions are returned newest-first, mirroring ``uv pip index versions``.
    When that command yields nothing usable, discovery falls back to the PyPI
    JSON API over stdlib ``urllib``. When ``verbose`` is set, the uv command and
    its raw output are echoed so a failed or empty discovery can be debugged.
    """
    cfg = cfg or resolve_env()
    print(f"Retrieving versions for '{package}' from {index_url}...")
    cmd = [
        "uv",
        "pip",
        "index",
        "versions",
        package,
    ]
    # Strip any -v/-vv from the discovery query: we only need the single
    # "Available versions:" line, but verbose uv emits a flood of resolver
    # output that bloats the captured buffer (and overflows the Node twin's
    # spawnSync limit). Keep the discovery query quiet.
    cmd += _strip_verbose(uv_options(cfg))
    if index_url:
        cmd += ["--index-url", index_url]
    if verbose:
        print(f"  $ {' '.join(cmd)}")

    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, check=True, env=subprocess_env(cfg)
        )
    except FileNotFoundError:
        if verbose:
            print("  uv not found on PATH; falling back to PyPI JSON API.")
        return _versions_from_pypi(package, cfg, verbose=verbose)
    except subprocess.CalledProcessError as e:
        if verbose:
            _echo(e.stdout, e.stderr)
        # A negative returncode means the child was killed by a signal, leaving
        # stderr empty — fall back to the signal name so the failure isn't blank.
        detail = (e.stderr or "").strip()
        if not detail and e.returncode is not None and e.returncode < 0:
            try:
                detail = f"terminated by signal {signal.Signals(-e.returncode).name}"
            except ValueError:
                detail = f"terminated by signal {-e.returncode}"
        print(f"'uv pip index versions' failed: {detail or 'unknown error'}; "
              "falling back to PyPI JSON API.", file=sys.stderr)
        return _versions_from_pypi(package, cfg, verbose=verbose)

    if verbose:
        _echo(result.stdout)
    match = re.search(r"Available versions:\s*(.*)", result.stdout)
    if not match:
        if verbose:
            print("  No 'Available versions:' line; falling back to PyPI JSON API.")
        return _versions_from_pypi(package, cfg, verbose=verbose)
    return [v.strip() for v in match.group(1).split(",") if v.strip()]


def _versions_from_pypi(package, cfg=None, verbose=False):
    """Fallback discovery: PyPI JSON API ``releases`` keys, newest-first."""
    cfg = cfg or resolve_env()
    url = f"{PYPI_JSON_BASE}/{package}/json"
    if verbose:
        print(f"  $ GET {url}")
    try:
        with urllib.request.urlopen(url, timeout=int(cfg["UV_HTTP_TIMEOUT"])) as resp:
            data = json.load(resp)
    except Exception as e:  # urllib.error.URLError, HTTPError, JSON, timeout
        print(f"Error querying PyPI JSON API: {e}", file=sys.stderr)
        return []
    releases = data.get("releases", {})
    if not releases:
        print("Could not find 'releases' in PyPI JSON output.", file=sys.stderr)
        return []
    return sorted(releases.keys(), key=_version_key, reverse=True)


def _version_key(version):
    """Best-effort sort key: split into numeric/non-numeric tokens."""
    return [int(t) if t.isdigit() else t for t in re.split(r"[.\-_+]", version)]


def setup_venv(env_dir, uv_version=DEFAULT_UV_VERSION, cfg=None, verbose=False):
    """Create a fresh ``uv venv`` sandbox if needed; return the venv dir.

    The sandbox is built with ``uv venv`` and install-tests run
    ``uv pip install`` into it (via ``--python``) against the pinned
    ``uv_version`` (default ``DEFAULT_UV_VERSION``) so they exercise a known
    resolver. Pass ``uv_version=None`` to keep whatever uv is on PATH.
    ``verbose`` echoes the uv-version output so a mismatch can be debugged.
    """
    cfg = cfg or resolve_env()
    if not os.path.exists(env_dir):
        print(f"Creating uv virtual environment at: {env_dir}")
        cmd = ["uv", "venv", env_dir] + uv_options(cfg)
        if verbose:
            print(f"  $ {' '.join(cmd)}")
        res = subprocess.run(cmd, capture_output=True, text=True, env=subprocess_env(cfg))
        if verbose:
            _echo(res.stdout, res.stderr)
        if res.returncode != 0:
            print(
                f"Warning: could not create uv venv: "
                f"{_last_line(res.stderr) or 'unknown error'}",
                file=sys.stderr,
            )

    if os.name == "nt":  # Windows
        py_path = os.path.join(env_dir, "Scripts", "python.exe")
    else:
        py_path = os.path.join(env_dir, "bin", "python")  # macOS / Linux

    if uv_version:
        _ensure_uv_version(uv_version, cfg, verbose=verbose)
    return py_path


def _ensure_uv_version(uv_version, cfg=None, verbose=False):
    """Report whether uv on PATH matches the requested ``uv_version``."""
    cfg = cfg or resolve_env()
    print(f"Ensuring uv=={uv_version} for the test environment...")
    cmd = ["uv", "--version"]
    if verbose:
        print(f"  $ {' '.join(cmd)}")
    res = subprocess.run(cmd, capture_output=True, text=True, env=subprocess_env(cfg))
    if verbose:
        _echo(res.stdout, res.stderr)
    if res.returncode != 0:
        print(
            f"Warning: could not verify uv=={uv_version}: "
            f"{_last_line(res.stderr) or 'unknown error'}",
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
    """True if uv ``options`` already carry a ``-v``/``-vv`` flag."""
    return any(o.startswith("-v") for o in options)


def _strip_verbose(options):
    """Return ``options`` with any ``-v``/``-vv``/``-vvv`` verbosity flag removed."""
    return [o for o in options if not re.fullmatch(r"-v+", o)]


def _stream(cmd, env):
    """Run ``cmd``, echoing combined output live while capturing it.

    Returns ``(returncode, combined_output)``. Used in verbose mode so the user
    watches uv in real time (e.g. a slow build or a hang) yet the captured text
    still feeds the JSON report.
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


def test_installations(py_path, package, index_url, versions, output_json,
                       first_only=False, cfg=None, verbose=False):
    """Attempt to install each version; write an incremental JSON report.

    Returns the list of result dicts. If ``first_only`` is set, stops after
    the first version that installs successfully. When ``verbose`` is set, uv's
    full output is streamed live (and a ``-v`` flag is added if none is present)
    so install failures can be debugged; the captured output is also folded into
    the report under ``log``/``error``.
    """
    cfg = cfg or resolve_env()
    env = subprocess_env(cfg)
    options = uv_options(cfg)
    results = []
    installable = []

    for idx, version in enumerate(versions, start=1):
        target = f"{package}=={version}"
        print(f"[{idx}/{len(versions)}] Attempting to install: {target}...")

        cmd = [
            "uv",
            "pip",
            "install",
            target,
            "--python",
            py_path,
            "--reinstall",
            "--no-cache",
        ]
        cmd += options
        if index_url:
            cmd += ["--index-url", index_url]
        # Bump uv's own verbosity if the user wants detail and nothing already set it.
        if verbose and not _has_verbose(options):
            cmd.append("-v")

        if verbose:
            print(f"  $ {' '.join(cmd)}")
            returncode, output = _stream(cmd, env)
            stdout_text = stderr_text = output  # streamed combined; same text both ways
        else:
            res = subprocess.run(cmd, capture_output=True, text=True, env=env)
            returncode, stdout_text, stderr_text = res.returncode, res.stdout, res.stderr

        if returncode == 0:
            print(f"  ✅ SUCCESS: {target}")
            results.append({
                "version": version,
                "status": "success",
                "log": _last_line(stdout_text) or _last_line(stderr_text),
            })
            installable.append(version)
        else:
            print(f"  ❌ FAILED: {target}")
            results.append({
                "version": version,
                "status": "failed",
                "error": _last_line(stderr_text) or "Unknown error",
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
        description="Find installable versions of a package from a registry.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("package", help="Package name to probe (e.g. numpy).")
    p.add_argument(
        "--index-url",
        default=None,
        help="Custom registry simple index URL. Defaults to $UV_INDEX_URL, "
             "then $PYTHON_REGISTRY_URL, then https://pypi.org/simple.",
    )
    p.add_argument(
        "--venv-dir",
        default=".venv-test-install",
        help="Directory for the isolated uv venv sandbox.",
    )
    p.add_argument(
        "--uv-version",
        default=DEFAULT_UV_VERSION,
        help="uv version expected on PATH ('none' to keep whatever is installed).",
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
        help="Stream full uv output for every step so failures are debuggable.",
    )
    return p.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)

    cfg = resolve_env()
    index_url = resolve_index_url(args.index_url, cfg)

    versions = get_available_versions(args.package, index_url, cfg, verbose=args.verbose)
    if not versions:
        print("No versions found. Exiting.")
        return 1

    if args.limit is not None:
        versions = versions[: args.limit]

    print(f"Found {len(versions)} version(s) to test "
          f"(registry: {cfg['PYTHON_REGISTRY_NAME']}).")
    uv_version = None if str(args.uv_version).lower() == "none" else args.uv_version
    py_path = setup_venv(args.venv_dir, uv_version, cfg, verbose=args.verbose)
    test_installations(
        py_path,
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
# Example — probe the newest 5 versions of numpy, stop at the first installable:
#     main(["numpy", "--index-url", "https://reg.example.com/simple",
#           "--limit", "5", "--first-only"])
#
# Equivalent on the command line:
#     python3 main.py numpy \
#         --index-url https://reg.example.com/simple --limit 5 --first-only

if __name__ == "__main__":
    raise SystemExit(main())  # argv=None -> parse_args reads sys.argv
