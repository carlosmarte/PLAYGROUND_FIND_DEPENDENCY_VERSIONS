#!/usr/bin/env python3
"""Find installable versions of a package from a (custom) package registry.

Discovers every version a registry advertises for a package via
``pip index versions``, then attempts to install each one in an isolated
virtual environment, recording success/failure per version to a JSON report.

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
import venv

# pip version the test environment is pinned to by default. Install-tests run
# against this pip, so it governs resolver/cooldown behaviour. Override via
# --pip-version (CLI) or the `pip` command (REPL).
DEFAULT_PIP_VERSION = "26.1.1"

# Environment knobs read via os.environ.get, each falling back to the value the
# Python packaging / TLS ecosystem uses by default ("industry standard"). pip
# itself auto-reads PIP_* vars from the environment; we resolve them explicitly
# so the documented default still applies when the var is unset, and so they can
# be surfaced (REPL `env`) and threaded into every pip invocation we build.
ENV_DEFAULTS = {
    "PIP_VERBOSE": "0",                              # pip: quiet (0 = no -v)
    "PIP_CERT": "",                                  # pip: use certifi/system store
    "PIP_INDEX": "https://pypi.org/pypi",            # pip: legacy XML-RPC/JSON base
    "PIP_INDEX_URL": "https://pypi.org/simple",      # pip: PEP 503 simple index
    "PIP_TRUSTED_HOST": "",                          # pip: no extra trusted hosts
    "PIP_DEFAULT_TIMEOUT": "15",                     # pip: 15s socket timeout
    "PIP_RETRIES": "5",                              # pip: 5 connection retries
    "PYTHON_REGISTRY_URL": "https://pypi.org/simple",  # our index-url fallback
    "PYTHON_REGISTRY_NAME": "PyPI",                  # registry display name
    "REQUESTS_CA_BUNDLE": "",                        # requests/urllib3: certifi
    "SSL_CERT_FILE": "",                             # OpenSSL: system CA file
    "SSL_CERT_DIR": "",                              # OpenSSL: system CA dir
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
    """Pick the index URL: explicit flag > PIP_INDEX_URL > PYTHON_REGISTRY_URL."""
    cfg = cfg or resolve_env()
    return explicit or cfg["PIP_INDEX_URL"] or cfg["PYTHON_REGISTRY_URL"] or None


def pip_options(cfg):
    """Translate resolved config into pip command-line flags."""
    opts = []
    try:
        level = int(cfg["PIP_VERBOSE"])
    except (TypeError, ValueError):
        level = 0
    if level > 0:
        opts.append("-" + "v" * level)  # -v / -vv / -vvv ...
    if cfg["PIP_CERT"]:
        opts += ["--cert", cfg["PIP_CERT"]]
    if cfg["PIP_TRUSTED_HOST"]:
        opts += ["--trusted-host", cfg["PIP_TRUSTED_HOST"]]
    opts += ["--timeout", str(cfg["PIP_DEFAULT_TIMEOUT"])]
    opts += ["--retries", str(cfg["PIP_RETRIES"])]
    return opts


def subprocess_env(cfg):
    """Child-process environment with resolved TLS cert vars applied."""
    env = os.environ.copy()
    for name in _TLS_ENV_VARS:
        if cfg[name]:
            env[name] = cfg[name]
    if cfg["PIP_CERT"]:
        env["PIP_CERT"] = cfg["PIP_CERT"]
    return env


def get_available_versions(package, index_url, cfg=None, verbose=False):
    """Return the list of versions a registry advertises for ``package``.

    Versions are returned newest-first, mirroring ``pip index versions``. When
    ``verbose`` is set, the pip command and its raw output are echoed so a failed
    or empty discovery can be debugged.
    """
    cfg = cfg or resolve_env()
    print(f"Retrieving versions for '{package}' from {index_url}...")
    cmd = [
        sys.executable,
        "-m",
        "pip",
        "index",
        "versions",
        package,
    ]
    # Strip any -v/-vv from PIP_VERBOSE for this query: we only need the single
    # "Available versions:" line, but verbose pip emits a line per registry link
    # — a flood of output that bloats the captured buffer (and overflows the
    # Node twin's spawnSync limit). Keep the discovery query quiet.
    cmd += _strip_verbose(pip_options(cfg))
    if index_url:
        cmd += ["--index-url", index_url]
    if verbose:
        print(f"  $ {' '.join(cmd)}")

    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, check=True, env=subprocess_env(cfg)
        )
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
        print(
            f"Error running 'pip index versions': {detail or 'unknown error'}",
            file=sys.stderr,
        )
        sys.exit(1)

    if verbose:
        _echo(result.stdout)
    match = re.search(r"Available versions:\s*(.*)", result.stdout)
    if not match:
        print("Could not find 'Available versions:' in pip output.", file=sys.stderr)
        return []
    return [v.strip() for v in match.group(1).split(",") if v.strip()]


def setup_venv(env_dir, pip_version=DEFAULT_PIP_VERSION, cfg=None, verbose=False, index_url=None):
    """Create a fresh virtual environment if needed; return its pip path.

    The venv's pip is pinned to ``pip_version`` (default ``DEFAULT_PIP_VERSION``)
    so install-tests run against a known pip. Pass ``pip_version=None`` to keep
    whatever pip the venv was bootstrapped with. ``verbose`` echoes the pip-pin
    output so a failed pin can be debugged. ``index_url`` is the resolved
    registry the pin is fetched from, so the pinned pip comes from the SAME
    registry the version probe and install-tests use (pass ``None`` for pip's
    default).
    """
    cfg = cfg or resolve_env()
    if not os.path.exists(env_dir):
        print(f"Creating virtual environment at: {env_dir}")
        venv.create(env_dir, with_pip=True)

    if os.name == "nt":  # Windows
        pip_path = os.path.join(env_dir, "Scripts", "pip.exe")
    else:
        pip_path = os.path.join(env_dir, "bin", "pip")  # macOS / Linux

    if pip_version:
        _ensure_pip_version(pip_path, pip_version, cfg, verbose=verbose, index_url=index_url)
    return pip_path


def _ensure_pip_version(pip_path, pip_version, cfg=None, verbose=False, index_url=None):
    """Pin the venv's pip to ``pip_version`` (fetched from the resolved registry)."""
    cfg = cfg or resolve_env()
    print(f"Ensuring pip=={pip_version} in the test environment...")
    cmd = (
        [pip_path, "install", "--disable-pip-version-check", f"pip=={pip_version}"]
        + pip_options(cfg)
    )
    # Fetch the pinned pip from the same registry as discovery / install-tests,
    # not whatever ambient default pip would otherwise use.
    if index_url:
        cmd += ["--index-url", index_url]
    if verbose:
        print(f"  $ {' '.join(cmd)}")
    res = subprocess.run(cmd, capture_output=True, text=True, env=subprocess_env(cfg))
    if verbose:
        _echo(res.stdout, res.stderr)
    if res.returncode != 0:
        print(
            f"Warning: could not pin pip=={pip_version}: "
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
    """True if pip ``options`` already carry a ``-v``/``-vv`` flag."""
    return any(o.startswith("-v") for o in options)


def _strip_verbose(options):
    """Return ``options`` with any ``-v``/``-vv``/``-vvv`` verbosity flag removed."""
    return [o for o in options if not re.fullmatch(r"-v+", o)]


def _stream(cmd, env):
    """Run ``cmd``, echoing combined output live while capturing it.

    Returns ``(returncode, combined_output)``. Used in verbose mode so the user
    watches pip in real time (e.g. a slow build or a hang) yet the captured text
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


def test_installations(pip_path, package, index_url, versions, output_json,
                       first_only=False, cfg=None, verbose=False):
    """Attempt to install each version; write an incremental JSON report.

    Returns the list of result dicts. If ``first_only`` is set, stops after
    the first version that installs successfully. When ``verbose`` is set, pip's
    full output is streamed live (and a ``--verbose -v`` flag is added if none is
    present) so install failures can be debugged; the captured output is also
    folded into the report under ``log``/``error``.
    """
    cfg = cfg or resolve_env()
    env = subprocess_env(cfg)
    options = pip_options(cfg)
    results = []
    installable = []

    for idx, version in enumerate(versions, start=1):
        target = f"{package}=={version}"
        print(f"[{idx}/{len(versions)}] Attempting to install: {target}...")

        cmd = [
            pip_path,
            "install",
            target,
            "--force-reinstall",
            "--no-cache-dir",
        ]
        cmd += options
        if index_url:
            cmd += ["--index-url", index_url]
        # Bump pip's own verbosity if the user wants detail and nothing already set it.
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
                "log": _last_line(stdout_text),
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
        help="Custom registry simple index URL. Defaults to $PIP_INDEX_URL, "
             "then $PYTHON_REGISTRY_URL, then https://pypi.org/simple.",
    )
    p.add_argument(
        "--venv-dir",
        default=".venv-test-install",
        help="Directory for the isolated test virtual environment.",
    )
    p.add_argument(
        "--pip-version",
        default=DEFAULT_PIP_VERSION,
        help="pip version to pin in the test venv ('none' to keep the bootstrapped pip).",
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
        help="Stream full pip output for every step so failures are debuggable.",
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
    pip_version = None if str(args.pip_version).lower() == "none" else args.pip_version
    pip_path = setup_venv(args.venv_dir, pip_version, cfg, verbose=args.verbose, index_url=index_url)
    test_installations(
        pip_path,
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
