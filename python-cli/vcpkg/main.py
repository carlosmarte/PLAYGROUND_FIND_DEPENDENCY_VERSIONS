#!/usr/bin/env python3
"""Find installable versions of a port from the (custom) vcpkg registry.

Discovers every version the vcpkg versions database advertises for a port via
``versions/<first-letter>-/<port>.json``, then attempts to ``vcpkg install``
each one in an isolated vcpkg checkout, recording success/failure per version to
a JSON report.

Example:
    python main.py fmt \
        --registry https://raw.githubusercontent.com/microsoft/vcpkg/master

    # only probe the newest 5 versions, stop at the first that installs
    python main.py fmt --registry https://raw.githubusercontent.com/microsoft/vcpkg/master \
        --limit 5 --first-only
"""

import argparse
import json
import os
import re
import signal
import subprocess
import sys
import urllib.error
import urllib.request

# vcpkg version the test environment is pinned to by default. Install-tests run
# against this vcpkg, so it governs baseline/registry behaviour. This is a soft
# pin (we only warn if vcpkg reports a different version) since the vcpkg tool is
# host-provided (a git checkout), not bootstrapped. Override via --vcpkg-version
# (CLI) or the `vcpkg` command (REPL).
DEFAULT_VCPKG_VERSION = "2024-10-18"

# Environment knobs read via os.environ.get, each falling back to the value the
# vcpkg ecosystem uses by default ("industry standard"). vcpkg itself auto-reads
# VCPKG_* vars from the environment; we resolve them explicitly so the documented
# default still applies when the var is unset, and so they can be surfaced (REPL
# `env`) and threaded into every vcpkg invocation we build.
ENV_DEFAULTS = {
    "VCPKG_VERBOSE": "0",                               # our: quiet (0 = no --debug)
    "VCPKG_ROOT": "",                                   # vcpkg: checkout root (the toolchain)
    "VCPKG_DEFAULT_TRIPLET": "",                         # vcpkg: target triplet (e.g. x64-linux)
    "VCPKG_DOWNLOADS": "",                              # vcpkg: downloads cache dir
    "VCPKG_REGISTRY": "https://raw.githubusercontent.com/microsoft/vcpkg/master",  # versions DB base
    "VCPKG_DEFAULT_TIMEOUT": "15",                      # our: 15s HTTP timeout
    "VCPKG_RETRIES": "5",                               # our: 5 connection retries
    "PORT_REGISTRY_URL": "https://raw.githubusercontent.com/microsoft/vcpkg/master",  # our base fallback
    "PORT_REGISTRY_NAME": "vcpkg",                      # registry display name
    "REQUESTS_CA_BUNDLE": "",                           # requests/urllib3: certifi
    "SSL_CERT_FILE": "",                                # OpenSSL: system CA file
    "SSL_CERT_DIR": "",                                 # OpenSSL: system CA dir
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
    """Pick the registry base: explicit flag > VCPKG_REGISTRY > PORT_REGISTRY_URL."""
    cfg = cfg or resolve_env()
    return explicit or cfg["VCPKG_REGISTRY"] or cfg["PORT_REGISTRY_URL"] or None


def vcpkg_options(cfg):
    """Translate resolved config into vcpkg command-line flags."""
    opts = []
    try:
        level = int(cfg["VCPKG_VERBOSE"])
    except (TypeError, ValueError):
        level = 0
    if level > 0:
        opts.append("--debug")  # vcpkg: verbose debug output
    if cfg["VCPKG_DEFAULT_TRIPLET"]:
        opts += ["--triplet", cfg["VCPKG_DEFAULT_TRIPLET"]]
    return opts


def subprocess_env(cfg):
    """Child-process environment with resolved TLS cert + vcpkg vars applied."""
    env = os.environ.copy()
    for name in _TLS_ENV_VARS:
        if cfg[name]:
            env[name] = cfg[name]
    if cfg["VCPKG_ROOT"]:
        env["VCPKG_ROOT"] = cfg["VCPKG_ROOT"]
    if cfg["VCPKG_DOWNLOADS"]:
        env["VCPKG_DOWNLOADS"] = cfg["VCPKG_DOWNLOADS"]
    return env


def _http_get_json(url, cfg, headers=None, verbose=False):
    """GET ``url`` and parse a JSON body via stdlib urllib (no third-party deps).

    Returns the decoded JSON object, or ``None`` on any HTTP/parse error (the
    caller degrades gracefully). ``verbose`` echoes the request and any error.
    """
    try:
        timeout = int(cfg["VCPKG_DEFAULT_TIMEOUT"])
    except (TypeError, ValueError):
        timeout = 15
    req = urllib.request.Request(url, headers=headers or {})
    if verbose:
        print(f"  $ GET {url}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, ValueError) as e:
        if verbose:
            print(f"  ! {e}")
        return None


def get_available_versions(package, index_url, cfg=None, verbose=False):
    """Return the list of versions the vcpkg versions DB advertises for ``package``.

    The versions DB shards ports by first letter under
    ``versions/<first-letter>-/<port>.json``; its ``versions[]`` array lists
    newest-first, which we preserve. When ``verbose`` is set, the request and raw
    response are echoed so a failed or empty discovery can be debugged.
    """
    cfg = cfg or resolve_env()
    print(f"Retrieving versions for '{package}' from {index_url}...")
    first = package[0].lower() if package else "_"
    url = f"{index_url}/versions/{first}-/{package}.json"
    data = _http_get_json(url, cfg, verbose=verbose)
    if not data or not isinstance(data.get("versions"), list):
        print("Could not find 'versions' in vcpkg versions DB response.", file=sys.stderr)
        return []
    # Each entry carries a "version"/"version-semver"/"version-string"/"version-date".
    versions = []
    for entry in data["versions"]:
        ver = (
            entry.get("version")
            or entry.get("version-semver")
            or entry.get("version-string")
            or entry.get("version-date")
        )
        if ver:
            versions.append(str(ver))
    return versions  # DB lists newest-first already


def setup_venv(env_dir, vcpkg_version=DEFAULT_VCPKG_VERSION, cfg=None, verbose=False):
    """Create a fresh sandbox directory if needed; return its path.

    For vcpkg the "sandbox" is a scratch directory where each install-test writes
    a temp manifest (``vcpkg.json``) and installs into ``vcpkg_installed``. The
    vcpkg tool is pinned to ``vcpkg_version`` (default ``DEFAULT_VCPKG_VERSION``)
    as a *soft* check — we warn on mismatch rather than bootstrap a checkout.
    Pass ``vcpkg_version=None`` to skip the check. ``verbose`` echoes the version
    output so a failed check can be debugged.
    """
    cfg = cfg or resolve_env()
    if not os.path.exists(env_dir):
        print(f"Creating sandbox directory at: {env_dir}")
        os.makedirs(env_dir, exist_ok=True)

    # The "tool path" for vcpkg is the sandbox dir; temp manifests are written
    # there and the vcpkg binary is on PATH or under $VCPKG_ROOT.
    sandbox_path = env_dir

    if vcpkg_version:
        _ensure_vcpkg_version(sandbox_path, vcpkg_version, cfg, verbose=verbose)
    return sandbox_path


def _ensure_vcpkg_version(sandbox_path, vcpkg_version, cfg=None, verbose=False):
    """Verify the vcpkg tool reports ``vcpkg_version`` (soft pin; warns)."""
    cfg = cfg or resolve_env()
    print(f"Ensuring vcpkg=={vcpkg_version} in the test environment...")
    cmd = ["vcpkg", "version"]
    if verbose:
        print(f"  $ {' '.join(cmd)}")
    res = subprocess.run(cmd, capture_output=True, text=True, env=subprocess_env(cfg))
    if verbose:
        _echo(res.stdout, res.stderr)
    # vcpkg prints a banner line like "vcpkg package management program version 2024-10-18-..."
    match = re.search(r"version\s+([0-9][\w.\-]*)", res.stdout or "")
    found = match.group(1) if match else ""
    if res.returncode != 0 or not found.startswith(vcpkg_version):
        # A negative returncode means the child was killed by a signal, leaving
        # no banner — surface the signal name rather than a misleading
        # "unknown error".
        detail = found or _signal_detail(res.returncode) or "unknown error"
        print(
            f"Warning: could not pin vcpkg=={vcpkg_version}: "
            f"tool reports {detail}",
            file=sys.stderr,
        )


def _last_line(text):
    """Return the last non-empty line of ``text`` (for compact logging)."""
    lines = [ln for ln in (text or "").strip().splitlines() if ln.strip()]
    return lines[-1] if lines else ""


def _signal_detail(returncode):
    """Describe a signal-kill (negative ``returncode``) as ``terminated by signal <name>``.

    Returns an empty string when ``returncode`` is not a signal kill, so callers
    can chain it after their stderr-derived detail.
    """
    if returncode is None or returncode >= 0:
        return ""
    try:
        return f"terminated by signal {signal.Signals(-returncode).name}"
    except ValueError:
        return f"terminated by signal {-returncode}"


def _echo(*texts):
    """Write each non-empty text to stdout (newline-terminated). Verbose helper."""
    for t in texts:
        if t:
            sys.stdout.write(t if t.endswith("\n") else t + "\n")


def _has_verbose(options):
    """True if vcpkg ``options`` already carry a ``--debug`` flag."""
    return any(o == "--debug" for o in options)


def _stream(cmd, env, cwd=None):
    """Run ``cmd``, echoing combined output live while capturing it.

    Returns ``(returncode, combined_output)``. Used in verbose mode so the user
    watches vcpkg in real time (e.g. a slow build or a hang) yet the captured
    text still feeds the JSON report.
    """
    proc = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env, cwd=cwd,
    )
    chunks = []
    for line in proc.stdout:
        sys.stdout.write(line)
        sys.stdout.flush()
        chunks.append(line)
    proc.wait()
    return proc.returncode, "".join(chunks)


def test_installations(sandbox_path, package, index_url, versions, output_json,
                       first_only=False, cfg=None, verbose=False):
    """Attempt to ``vcpkg install`` each version; write an incremental JSON report.

    Returns the list of result dicts. If ``first_only`` is set, stops after
    the first version that installs successfully. When ``verbose`` is set,
    vcpkg's full output is streamed live (and a ``--debug`` flag is added if none
    is present) so install failures can be debugged; the captured output is also
    folded into the report under ``log``/``error``.

    Each version installs in classic mode pinned via ``--version`` so the vcpkg
    versioning resolver fetches exactly that port version from the registry.
    """
    cfg = cfg or resolve_env()
    env = subprocess_env(cfg)
    options = vcpkg_options(cfg)
    results = []
    installable = []

    for idx, version in enumerate(versions, start=1):
        target = f"{package}@{version}"
        print(f"[{idx}/{len(versions)}] Attempting to install: {target}...")

        cmd = ["vcpkg", "install", f"{package}", "--version", version]
        cmd += options
        # Bump vcpkg's own verbosity if the user wants detail and nothing set it.
        if verbose and not _has_verbose(options):
            cmd.append("--debug")

        if verbose:
            print(f"  $ {' '.join(cmd)}  (cwd={sandbox_path})")
            returncode, output = _stream(cmd, env, cwd=sandbox_path)
            stdout_text = stderr_text = output  # streamed combined; same text both ways
        else:
            res = subprocess.run(cmd, capture_output=True, text=True, env=env, cwd=sandbox_path)
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
            # A negative returncode means the child was killed by a signal,
            # leaving stderr empty — fall back to the signal name so the failure
            # isn't recorded blank.
            error = _last_line(stderr_text) or _signal_detail(returncode) or "Unknown error"
            results.append({
                "version": version,
                "status": "failed",
                "error": error,
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
        description="Find installable versions of a port from the vcpkg registry.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("package", help="Port name to probe (e.g. fmt).")
    p.add_argument(
        "--registry",
        dest="index_url",
        default=None,
        help="Custom vcpkg versions-DB base URL. Defaults to $VCPKG_REGISTRY, "
             "then $PORT_REGISTRY_URL, then the microsoft/vcpkg master tree.",
    )
    p.add_argument(
        "--venv-dir",
        default=".venv-test-install",
        help="Directory for the isolated install sandbox.",
    )
    p.add_argument(
        "--vcpkg-version",
        default=DEFAULT_VCPKG_VERSION,
        help="vcpkg version to expect ('none' to skip the check).",
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
        help="Stream full vcpkg output for every step so failures are debuggable.",
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
          f"(registry: {cfg['PORT_REGISTRY_NAME']}).")
    vcpkg_version = None if str(args.vcpkg_version).lower() == "none" else args.vcpkg_version
    sandbox_path = setup_venv(args.venv_dir, vcpkg_version, cfg, verbose=args.verbose)
    test_installations(
        sandbox_path,
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
# Example — probe the newest 5 versions of fmt, stop at the first installable:
#     main(["fmt", "--registry", "https://raw.githubusercontent.com/microsoft/vcpkg/master",
#           "--limit", "5", "--first-only"])
#
# Equivalent on the command line:
#     python3 main.py fmt \
#         --registry https://raw.githubusercontent.com/microsoft/vcpkg/master --limit 5 --first-only

if __name__ == "__main__":
    raise SystemExit(main())  # argv=None -> parse_args reads sys.argv
