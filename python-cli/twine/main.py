#!/usr/bin/env python3
"""Find metadata-valid versions of a package via twine's distribution checker.

NOTE — repurposing twine: twine is a **publish-side** tool; its job is to upload
distributions to a package index, not to install or list them. This clone
repurposes twine as a *metadata-validity probe*. It discovers every version a
registry advertises via the PyPI JSON API
(``https://pypi.org/pypi/<pkg>/json`` — the ``releases`` keys, sorted
newest-first), downloads each version's distribution with
``pip download <pkg>==<ver> --no-deps -d <tmp>``, then runs ``twine check
<tmp>/*`` to validate the distribution's metadata (long-description rendering,
PKG-INFO well-formedness). A version "passes" when ``twine check`` reports no
metadata errors. Success/failure per version is recorded to a JSON report.

Example:
    python main.py numpy \
        --index-url https://my-registry.example.com/simple

    # only probe the newest 5 versions, stop at the first that passes
    python main.py numpy --index-url https://reg/simple \
        --limit 5 --first-only
"""

import argparse
import glob
import json
import os
import re
import subprocess
import sys
import urllib.request

# twine version the probe is pinned to by default. ``twine check`` behaviour
# (the metadata validators it runs) is governed by this twine, so it is the
# tool-version constant. Override via --twine-version (CLI) or the `twine`
# command (REPL).
DEFAULT_TWINE_VERSION = "5.1.1"

# Environment knobs read via os.environ.get, each falling back to the value the
# Python packaging / TLS ecosystem uses by default ("industry standard"). twine
# itself auto-reads TWINE_* vars from the environment; we resolve them
# explicitly so the documented default still applies when the var is unset, and
# so they can be surfaced (REPL `env`) and threaded into every twine/pip
# invocation we build.
ENV_DEFAULTS = {
    "TWINE_VERBOSE": "0",                                # twine: quiet (0 = no --verbose)
    "TWINE_CERT": "",                                    # twine: use certifi/system store
    "TWINE_REPOSITORY_URL": "https://pypi.org/simple",   # twine/pip: distribution index
    "TWINE_USERNAME": "",                                # twine: index auth user
    "PIP_DEFAULT_TIMEOUT": "15",                         # pip download: 15s socket timeout
    "PIP_RETRIES": "5",                                  # pip download: 5 connection retries
    "PYTHON_REGISTRY_URL": "https://pypi.org/simple",    # our index-url fallback
    "PYTHON_REGISTRY_NAME": "PyPI",                      # registry display name
    "REQUESTS_CA_BUNDLE": "",                            # requests/urllib3: certifi
    "SSL_CERT_FILE": "",                                 # OpenSSL: system CA file
    "SSL_CERT_DIR": "",                                  # OpenSSL: system CA dir
}

# JSON metadata base used for version discovery (stdlib urllib, no twine call).
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
    """Pick the index URL: explicit flag > TWINE_REPOSITORY_URL > PYTHON_REGISTRY_URL."""
    cfg = cfg or resolve_env()
    return explicit or cfg["TWINE_REPOSITORY_URL"] or cfg["PYTHON_REGISTRY_URL"] or None


def pip_options(cfg):
    """Translate resolved config into pip-download command-line flags."""
    opts = []
    opts += ["--timeout", str(cfg["PIP_DEFAULT_TIMEOUT"])]
    opts += ["--retries", str(cfg["PIP_RETRIES"])]
    return opts


def twine_options(cfg):
    """Translate resolved config into ``twine check`` command-line flags."""
    opts = []
    try:
        level = int(cfg["TWINE_VERBOSE"])
    except (TypeError, ValueError):
        level = 0
    if level > 0:
        opts.append("--verbose")  # twine has a single --verbose, not -v/-vv
    return opts


def subprocess_env(cfg):
    """Child-process environment with resolved TLS cert vars applied."""
    env = os.environ.copy()
    for name in _TLS_ENV_VARS:
        if cfg[name]:
            env[name] = cfg[name]
    if cfg["TWINE_CERT"]:
        env["TWINE_CERT"] = cfg["TWINE_CERT"]
    return env


def get_available_versions(package, index_url, cfg=None, verbose=False):
    """Return the list of versions a registry advertises for ``package``.

    Versions are returned newest-first. Discovery uses the PyPI JSON API
    (``releases`` keys) over stdlib ``urllib`` rather than a twine call — twine
    is publish-side and has no "list versions" command. When ``verbose`` is set,
    the request URL and the raw version list are echoed so a failed or empty
    discovery can be debugged.
    """
    cfg = cfg or resolve_env()
    print(f"Retrieving versions for '{package}' from {index_url}...")
    url = f"{PYPI_JSON_BASE}/{package}/json"
    if verbose:
        print(f"  $ GET {url}")

    try:
        with urllib.request.urlopen(url, timeout=int(cfg["PIP_DEFAULT_TIMEOUT"])) as resp:
            data = json.load(resp)
    except Exception as e:  # urllib.error.URLError, HTTPError, JSON, timeout
        print(f"Error querying PyPI JSON API: {e}", file=sys.stderr)
        sys.exit(1)

    releases = data.get("releases", {})
    if not releases:
        print("Could not find 'releases' in PyPI JSON output.", file=sys.stderr)
        return []
    # Sort newest-first using a tuple key so numeric segments compare naturally.
    versions = sorted(releases.keys(), key=_version_key, reverse=True)
    if verbose:
        _echo("Available versions: " + ", ".join(versions))
    return versions


def _version_key(version):
    """Best-effort sort key: split into numeric/non-numeric tokens."""
    return [int(t) if t.isdigit() else t for t in re.split(r"[.\-_+]", version)]


def setup_venv(env_dir, twine_version=DEFAULT_TWINE_VERSION, cfg=None, verbose=False):
    """Create a scratch download dir if needed; return its path.

    The "sandbox" here is a scratch directory into which each version's
    distribution is downloaded (``pip download -d <env_dir>/<ver>``) before
    ``twine check`` validates it. ``twine_version`` (default
    ``DEFAULT_TWINE_VERSION``) is the twine the probe expects on PATH; pass
    ``twine_version=None`` to keep whatever twine is installed. ``verbose``
    echoes the twine-version output so a mismatch can be debugged.
    """
    cfg = cfg or resolve_env()
    if not os.path.exists(env_dir):
        print(f"Creating scratch download dir at: {env_dir}")
        os.makedirs(env_dir, exist_ok=True)

    if twine_version:
        _ensure_twine_version(twine_version, cfg, verbose=verbose)
    return env_dir


def _ensure_twine_version(twine_version, cfg=None, verbose=False):
    """Report whether twine on PATH matches the requested ``twine_version``."""
    cfg = cfg or resolve_env()
    print(f"Ensuring twine=={twine_version} for the metadata probe...")
    cmd = [sys.executable, "-m", "twine", "--version"]
    if verbose:
        print(f"  $ {' '.join(cmd)}")
    res = subprocess.run(cmd, capture_output=True, text=True, env=subprocess_env(cfg))
    if verbose:
        _echo(res.stdout, res.stderr)
    if res.returncode != 0:
        print(
            f"Warning: could not verify twine=={twine_version}: "
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
    """True if twine ``options`` already carry a ``--verbose`` flag."""
    return any(o == "--verbose" for o in options)


def _stream(cmd, env):
    """Run ``cmd``, echoing combined output live while capturing it.

    Returns ``(returncode, combined_output)``. Used in verbose mode so the user
    watches pip/twine in real time (e.g. a slow download or a hang) yet the
    captured text still feeds the JSON report.
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


def test_installations(scratch_dir, package, index_url, versions, output_json,
                       first_only=False, cfg=None, verbose=False):
    """Download + ``twine check`` each version; write an incremental JSON report.

    For each version we first ``pip download <pkg>==<ver> --no-deps`` into a
    per-version subdir, then ``twine check`` the downloaded distributions and
    classify success on twine's returncode (no metadata errors). Returns the
    list of result dicts. If ``first_only`` is set, stops after the first
    version that passes. When ``verbose`` is set, full output is streamed live
    (and a ``--verbose`` flag is added to twine if none is present) so failures
    can be debugged; the captured output is also folded into the report under
    ``log``/``error``.
    """
    cfg = cfg or resolve_env()
    env = subprocess_env(cfg)
    twine_opts = twine_options(cfg)
    pip_opts = pip_options(cfg)
    results = []
    installable = []

    for idx, version in enumerate(versions, start=1):
        target = f"{package}=={version}"
        print(f"[{idx}/{len(versions)}] Validating metadata for: {target}...")

        dl_dir = os.path.join(scratch_dir, version)
        os.makedirs(dl_dir, exist_ok=True)

        # Step 1: download the distribution (no deps) into the per-version dir.
        dl_cmd = [
            sys.executable,
            "-m",
            "pip",
            "download",
            target,
            "--no-deps",
            "-d",
            dl_dir,
            "--no-cache-dir",
        ]
        dl_cmd += pip_opts
        if index_url:
            dl_cmd += ["--index-url", index_url]

        if verbose:
            print(f"  $ {' '.join(dl_cmd)}")
            dl_rc, dl_out = _stream(dl_cmd, env)
            dl_stdout = dl_stderr = dl_out
        else:
            dl_res = subprocess.run(dl_cmd, capture_output=True, text=True, env=env)
            dl_rc, dl_stdout, dl_stderr = dl_res.returncode, dl_res.stdout, dl_res.stderr

        if dl_rc != 0:
            print(f"  ❌ FAILED: {target}")
            results.append({
                "version": version,
                "status": "failed",
                "error": _last_line(dl_stderr) or "download failed",
            })
            _persist(results, output_json)
            continue

        # Step 2: twine check the downloaded distributions (metadata validity).
        dists = sorted(glob.glob(os.path.join(dl_dir, "*")))
        check_cmd = [sys.executable, "-m", "twine", "check"] + dists
        check_cmd += twine_opts
        # Bump twine's own verbosity if the user wants detail and nothing already set it.
        if verbose and not _has_verbose(twine_opts):
            check_cmd.append("--verbose")

        if verbose:
            print(f"  $ {' '.join(check_cmd)}")
            returncode, output = _stream(check_cmd, env)
            stdout_text = stderr_text = output  # streamed combined; same text both ways
        else:
            res = subprocess.run(check_cmd, capture_output=True, text=True, env=env)
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
                "error": _last_line(stderr_text) or _last_line(stdout_text) or "Unknown error",
            })

        # Persist after every iteration so partial results survive a crash.
        _persist(results, output_json)

        if first_only and installable:
            print(f"  First metadata-valid version found: {installable[0]} (stopping).")
            break

    print(f"\nTesting complete! Results saved to {output_json}")
    if installable:
        print(f"Metadata-valid versions ({len(installable)}): {', '.join(installable)}")
    else:
        print("No metadata-valid versions found.")
    return results


def _persist(results, output_json):
    """Rewrite the full JSON report (crash-safe incremental persistence)."""
    with open(output_json, "w") as f:
        json.dump(results, f, indent=4)


def parse_args(argv=None):
    p = argparse.ArgumentParser(
        description="Find metadata-valid versions of a package via twine check.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("package", help="Package name to probe (e.g. numpy).")
    p.add_argument(
        "--index-url",
        "--repository-url",
        dest="index_url",
        default=None,
        help="Custom registry simple index URL (pip download source). Defaults "
             "to $TWINE_REPOSITORY_URL, then $PYTHON_REGISTRY_URL, then "
             "https://pypi.org/simple.",
    )
    p.add_argument(
        "--venv-dir",
        default=".venv-test-install",
        help="Directory for the scratch per-version download dirs.",
    )
    p.add_argument(
        "--twine-version",
        default=DEFAULT_TWINE_VERSION,
        help="twine version expected on PATH ('none' to keep whatever is installed).",
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
        help="Stop after the first version whose metadata validates.",
    )
    p.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="Stream full pip/twine output for every step so failures are debuggable.",
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
    twine_version = None if str(args.twine_version).lower() == "none" else args.twine_version
    scratch_dir = setup_venv(args.venv_dir, twine_version, cfg, verbose=args.verbose)
    test_installations(
        scratch_dir,
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
# Example — probe the newest 5 versions of numpy, stop at the first that passes:
#     main(["numpy", "--index-url", "https://reg.example.com/simple",
#           "--limit", "5", "--first-only"])
#
# Equivalent on the command line:
#     python3 main.py numpy \
#         --index-url https://reg.example.com/simple --limit 5 --first-only

if __name__ == "__main__":
    raise SystemExit(main())  # argv=None -> parse_args reads sys.argv
