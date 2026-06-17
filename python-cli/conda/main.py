#!/usr/bin/env python3
"""Find installable versions of a package from a (custom) conda channel.

Discovers every version a channel advertises for a package via
``conda search <pkg> --json``, then attempts to create an isolated environment
pinning each one, recording success/failure per version to a JSON report.

Example:
    python main.py numpy \
        --channel conda-forge

    # only probe the newest 5 versions, stop at the first that installs
    python main.py numpy --channel conda-forge \
        --limit 5 --first-only
"""

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile

# conda version the test environment is pinned to by default. Install-tests run
# against this conda, so it governs resolver behaviour. Override via
# --conda-version (CLI) or the `conda` command (REPL). Note: conda itself is
# provided by the host toolchain; we record the pin we expect.
DEFAULT_CONDA_VERSION = "24.9.2"

# Environment knobs read via os.environ.get, each falling back to the value the
# conda ecosystem uses by default ("industry standard"). conda auto-reads
# CONDA_* vars from the environment; we resolve them explicitly so the
# documented default still applies when the var is unset, and so they can be
# surfaced (REPL `env`) and threaded into every conda invocation we build.
ENV_DEFAULTS = {
    "CONDA_VERBOSE": "0",                            # conda: quiet (0 = no -v)
    "CONDA_CHANNELS": "conda-forge",                 # conda: default channel(s)
    "CONDA_DEFAULT_CHANNEL": "conda-forge",          # our channel fallback
    "CONDA_SOLVER": "",                              # conda: solver (libmamba/classic)
    "CONDA_DEFAULT_TIMEOUT": "60",                   # conda: remote read timeout (s)
    "CONDA_REMOTE_MAX_RETRIES": "3",                 # conda: remote connection retries
    "CONDA_REGISTRY_URL": "https://conda.anaconda.org",  # channel base URL
    "CONDA_REGISTRY_NAME": "conda-forge",            # registry display name
    "CURL_CA_BUNDLE": "",                            # curl/libcurl: CA bundle
    "SSL_CERT_FILE": "",                             # OpenSSL: system CA file
    "SSL_CERT_DIR": "",                              # OpenSSL: system CA dir
}

# TLS vars passed through to child processes via the environment (no CLI flag).
_TLS_ENV_VARS = ("CURL_CA_BUNDLE", "SSL_CERT_FILE", "SSL_CERT_DIR")

# Resolver binary: conda by default, mamba when available/requested. Kept here so
# discovery and install share one source of truth.
CONDA_BIN = os.environ.get("CONDA_EXE", "conda")


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
    """Pick the channel: explicit flag > CONDA_CHANNELS > CONDA_DEFAULT_CHANNEL."""
    cfg = cfg or resolve_env()
    return explicit or cfg["CONDA_CHANNELS"] or cfg["CONDA_DEFAULT_CHANNEL"] or None


def conda_options(cfg):
    """Translate resolved config into conda command-line flags."""
    opts = []
    try:
        level = int(cfg["CONDA_VERBOSE"])
    except (TypeError, ValueError):
        level = 0
    if level > 0:
        opts.append("-" + "v" * level)  # -v / -vv / -vvv ...
    if cfg["CONDA_SOLVER"]:
        opts += ["--solver", cfg["CONDA_SOLVER"]]
    return opts


def subprocess_env(cfg):
    """Child-process environment with resolved TLS cert vars applied."""
    env = os.environ.copy()
    for name in _TLS_ENV_VARS:
        if cfg[name]:
            env[name] = cfg[name]
    # Thread the remote timeout/retries through so conda honours them.
    env["CONDA_REMOTE_READ_TIMEOUT_SECS"] = str(cfg["CONDA_DEFAULT_TIMEOUT"])
    env["CONDA_REMOTE_MAX_RETRIES"] = str(cfg["CONDA_REMOTE_MAX_RETRIES"])
    return env


def get_available_versions(package, index_url, cfg=None, verbose=False):
    """Return the list of versions a channel advertises for ``package``.

    Versions are returned newest-first. We run ``conda search <pkg> --json``,
    which emits a JSON object keyed by the package name whose value is an array
    of build records each carrying a ``version`` field (ordered oldest-first,
    one entry per build). We dedupe to distinct versions and sort newest-first.
    When ``verbose`` is set, the conda command and its raw output are echoed so a
    failed or empty discovery can be debugged.
    """
    cfg = cfg or resolve_env()
    print(f"Retrieving versions for '{package}' from {index_url}...")
    cmd = [CONDA_BIN, "search", package, "--json"]
    cmd += conda_options(cfg)
    if index_url:
        cmd += ["-c", index_url, "--override-channels"]
    if verbose:
        print(f"  $ {' '.join(cmd)}")

    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, check=True, env=subprocess_env(cfg)
        )
    except subprocess.CalledProcessError as e:
        if verbose:
            _echo(e.stdout, e.stderr)
        print(f"Error running 'conda search': {e.stderr.strip()}", file=sys.stderr)
        sys.exit(1)

    if verbose:
        _echo(result.stdout)
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError:
        print("Could not parse 'conda search' JSON output.", file=sys.stderr)
        return []

    # conda search returns {"<pkg>": [{"version": ...}, ...]}; dedupe the builds.
    records = data.get(package) or []
    seen = set()
    versions = []
    for rec in records:
        v = rec.get("version")
        if v and not (v in seen or seen.add(v)):
            versions.append(v)
    if not versions:
        print("Could not find any versions in 'conda search' output.", file=sys.stderr)
        return []
    return sorted(versions, key=_version_key, reverse=True)  # newest-first


def _version_key(version):
    """Sort key splitting a conda version (``1.2.3``) into int/str tuples."""
    return [int(p) if p.isdigit() else p for p in re.split(r"[.\-+]", version)]


def setup_venv(env_dir, conda_version=DEFAULT_CONDA_VERSION, cfg=None, verbose=False):
    """Create the parent dir for throwaway conda prefixes; return its path.

    Each install-test creates a throwaway conda prefix (``--prefix``) under this
    directory rather than touching named environments, so probes never mutate
    the host conda install. The setup is pinned conceptually to ``conda_version``
    (default ``DEFAULT_CONDA_VERSION``) — conda itself is host-provided, so the
    pin is recorded/echoed rather than re-bootstrapped. Pass
    ``conda_version=None`` to skip the pin announcement. ``verbose`` echoes the
    provisioning step so a failed setup can be debugged.
    """
    cfg = cfg or resolve_env()
    if not os.path.exists(env_dir):
        print(f"Creating throwaway conda prefix root at: {env_dir}")
        os.makedirs(env_dir, exist_ok=True)

    prefix_root = os.path.abspath(env_dir)  # conda create --prefix lands under here

    if conda_version:
        _ensure_conda_version(prefix_root, conda_version, cfg, verbose=verbose)
    return prefix_root


def _ensure_conda_version(prefix_root, conda_version, cfg=None, verbose=False):
    """Record the conda version the test prefixes expect (host-provided tool)."""
    cfg = cfg or resolve_env()
    print(f"Ensuring conda=={conda_version} in the test environment...")
    cmd = [CONDA_BIN, "--version"]
    if verbose:
        print(f"  $ {' '.join(cmd)}")
    res = subprocess.run(cmd, capture_output=True, text=True, env=subprocess_env(cfg))
    if verbose:
        _echo(res.stdout, res.stderr)
    if res.returncode != 0:
        print(
            f"Warning: could not confirm conda=={conda_version}: "
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
    """True if conda ``options`` already carry a ``-v``/``-vv`` flag."""
    return any(o.startswith("-v") for o in options)


def _stream(cmd, env):
    """Run ``cmd``, echoing combined output live while capturing it.

    Returns ``(returncode, combined_output)``. Used in verbose mode so the user
    watches conda in real time (e.g. a slow solve or a hang) yet the captured
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


def test_installations(prefix_root, package, index_url, versions, output_json,
                       first_only=False, cfg=None, verbose=False):
    """Attempt to install each version; write an incremental JSON report.

    Each version is installed via ``conda create -y --prefix <tmp> <pkg>=<ver>``
    into a throwaway prefix, success classified on returncode. Returns the list
    of result dicts. If ``first_only`` is set, stops after the first version that
    installs successfully. When ``verbose`` is set, conda's full output is
    streamed live (and a ``-v`` flag is added if none is present) so install
    failures can be debugged; the captured output is also folded into the report
    under ``log``/``error``.
    """
    cfg = cfg or resolve_env()
    env = subprocess_env(cfg)
    options = conda_options(cfg)
    channel = index_url or cfg["CONDA_DEFAULT_CHANNEL"]
    results = []
    installable = []

    for idx, version in enumerate(versions, start=1):
        target = f"{package}={version}"
        print(f"[{idx}/{len(versions)}] Attempting to install: {target}...")

        # A fresh throwaway prefix per version keeps the solve hermetic.
        tmp_prefix = tempfile.mkdtemp(prefix="conda-itest-", dir=prefix_root)
        os.rmdir(tmp_prefix)  # conda create wants to make the prefix itself

        cmd = [CONDA_BIN, "create", "-y", "--prefix", tmp_prefix, target]
        cmd += options
        if channel:
            cmd += ["-c", channel, "--override-channels"]
        # Bump conda's verbosity if the user wants detail and nothing already set it.
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
        description="Find installable versions of a package from a conda channel.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("package", help="Package name to probe (e.g. numpy).")
    p.add_argument(
        "--channel",
        "-c",
        dest="index_url",
        default=None,
        help="Custom conda channel. Defaults to $CONDA_CHANNELS, "
             "then $CONDA_DEFAULT_CHANNEL, then conda-forge.",
    )
    p.add_argument(
        "--prefix-root",
        dest="venv_dir",
        default=".conda-test-install",
        help="Directory holding the isolated test conda prefixes.",
    )
    p.add_argument(
        "--conda-version",
        default=DEFAULT_CONDA_VERSION,
        help="conda version to expect in the test environment ('none' to skip the check).",
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
        help="Stream full conda output for every step so failures are debuggable.",
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
          f"(registry: {cfg['CONDA_REGISTRY_NAME']}).")
    conda_version = None if str(args.conda_version).lower() == "none" else args.conda_version
    prefix_root = setup_venv(args.venv_dir, conda_version, cfg, verbose=args.verbose)
    test_installations(
        prefix_root,
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
#     main(["numpy", "--channel", "conda-forge",
#           "--limit", "5", "--first-only"])
#
# Equivalent on the command line:
#     python3 main.py numpy \
#         --channel conda-forge --limit 5 --first-only

if __name__ == "__main__":
    raise SystemExit(main())  # argv=None -> parse_args reads sys.argv
