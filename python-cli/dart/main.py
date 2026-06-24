#!/usr/bin/env python3
"""Find installable versions of a package from a (custom) Dart pub registry.

Discovers every version a registry advertises for a package via the pub.dev
HTTP JSON API (``https://pub.dev/api/packages/<pkg>``), then attempts to add
each one to an isolated throwaway Dart package, recording success/failure per
version to a JSON report.

Example:
    python main.py http \
        --hosted-url https://pub.dev

    # only probe the newest 5 versions, stop at the first that installs
    python main.py http --hosted-url https://pub.dev \
        --limit 5 --first-only
"""

import argparse
import json
import os
import re
import signal
import subprocess
import sys
import tempfile
import urllib.request

# dart version the test environment is pinned to by default. Install-tests run
# against this dart, so it governs resolver/build behaviour. Override via
# --dart-version (CLI) or the `dart` command (REPL). Note: the dart SDK is
# provided by the host toolchain; we record the pin we expect.
DEFAULT_DART_VERSION = "3.5.4"

# Environment knobs read via os.environ.get, each falling back to the value the
# Dart / pub ecosystem uses by default ("industry standard"). The pub client
# auto-reads PUB_HOSTED_URL from the environment; we resolve it explicitly so
# the documented default still applies when the var is unset, and so they can be
# surfaced (REPL `env`) and threaded into every dart invocation we build.
ENV_DEFAULTS = {
    "PUB_VERBOSE": "0",                              # pub: quiet (0 = no --verbose)
    "PUB_HOSTED_URL": "https://pub.dev",             # pub: hosted package server
    "PUB_API_URL": "https://pub.dev",                # our version-listing API base
    "PUB_DEFAULT_TIMEOUT": "30",                     # pub: socket timeout (s)
    "PUB_RETRIES": "5",                              # pub: connection retries
    "DART_REGISTRY_URL": "https://pub.dev",          # our hosted-url fallback
    "DART_REGISTRY_NAME": "pub.dev",                 # registry display name
    "SSL_CERT_FILE": "",                             # OpenSSL: system CA file
    "SSL_CERT_DIR": "",                              # OpenSSL: system CA dir
    "CURL_CA_BUNDLE": "",                            # curl/libcurl: CA bundle
}

# TLS vars passed through to child processes via the environment (no CLI flag).
_TLS_ENV_VARS = ("SSL_CERT_FILE", "SSL_CERT_DIR", "CURL_CA_BUNDLE")


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
    """Pick the hosted URL: explicit flag > PUB_HOSTED_URL > DART_REGISTRY_URL."""
    cfg = cfg or resolve_env()
    return explicit or cfg["PUB_HOSTED_URL"] or cfg["DART_REGISTRY_URL"] or None


def pub_options(cfg):
    """Translate resolved config into dart/pub command-line flags.

    Dart's pub has a small option surface; we accumulate the knobs we honour
    (verbosity) as a list that ``test_installations`` weaves into the
    ``dart pub add`` invocation. Timeout/retries are threaded via the environment
    (``subprocess_env``) since pub reads them from there.
    """
    opts = []
    try:
        level = int(cfg["PUB_VERBOSE"])
    except (TypeError, ValueError):
        level = 0
    if level > 0:
        opts.append("--verbose")  # dart pub --verbose
    return opts


def subprocess_env(cfg):
    """Child-process environment with resolved TLS cert vars + hosted URL applied."""
    env = os.environ.copy()
    for name in _TLS_ENV_VARS:
        if cfg[name]:
            env[name] = cfg[name]
    # pub reads its hosted server from PUB_HOSTED_URL; thread the resolved value
    # so every `dart pub add` targets the chosen registry.
    if cfg["PUB_HOSTED_URL"]:
        env["PUB_HOSTED_URL"] = cfg["PUB_HOSTED_URL"]
    return env


def get_available_versions(package, index_url, cfg=None, verbose=False):
    """Return the list of versions a registry advertises for ``package``.

    Versions are returned newest-first, mirroring the pub.dev API ordering. pub
    has no native "list all versions" CLI, so we query the HTTP JSON API
    (``<PUB_API_URL>/api/packages/<pkg>``) via stdlib ``urllib``: the document
    carries a ``versions`` array of objects each with a ``version`` field,
    ordered oldest-first, which we reverse to newest-first. When ``verbose`` is
    set, the request URL and raw output are echoed so a failed or empty discovery
    can be debugged.
    """
    cfg = cfg or resolve_env()
    print(f"Retrieving versions for '{package}' from {index_url}...")
    api_url = cfg["PUB_API_URL"].rstrip("/")
    url = f"{api_url}/api/packages/{package}"
    if verbose:
        print(f"  $ GET {url}")

    try:
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=int(cfg["PUB_DEFAULT_TIMEOUT"])) as resp:
            raw = resp.read().decode("utf-8")
    except Exception as e:  # urllib raises a family of errors; treat all as fatal
        print(f"Error querying pub.dev API: {e}", file=sys.stderr)
        sys.exit(1)

    if verbose:
        _echo(raw)
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        print("Could not parse pub.dev JSON response.", file=sys.stderr)
        return []

    entries = data.get("versions") or []
    versions = [e.get("version") for e in entries if e.get("version")]
    if not versions:
        print("Could not find any versions in pub.dev output.", file=sys.stderr)
        return []
    return list(reversed(versions))  # API is oldest-first -> newest-first


def setup_venv(env_dir, dart_version=DEFAULT_DART_VERSION, cfg=None, verbose=False):
    """Create a fresh throwaway Dart package if needed; return its package dir.

    Each install-test runs ``dart pub add`` inside a scratch Dart package
    (created via ``dart create``) rather than against the host, so probes never
    mutate a real project. The package is pinned conceptually to ``dart_version``
    (default ``DEFAULT_DART_VERSION``) — the dart SDK itself is host-provided, so
    the pin is recorded/echoed rather than re-bootstrapped. Pass
    ``dart_version=None`` to skip the pin announcement. ``verbose`` echoes the
    provisioning step so a failed setup can be debugged.
    """
    cfg = cfg or resolve_env()
    if not os.path.exists(env_dir):
        print(f"Creating throwaway Dart package at: {env_dir}")
        os.makedirs(env_dir, exist_ok=True)
        _dart_create(env_dir, cfg, verbose=verbose)

    pkg_dir = os.path.abspath(env_dir)  # dart pub add runs in this directory

    if dart_version:
        _ensure_dart_version(pkg_dir, dart_version, cfg, verbose=verbose)
    return pkg_dir


def _dart_create(env_dir, cfg=None, verbose=False):
    """Scaffold a minimal Dart package the install-tests can add deps into."""
    cfg = cfg or resolve_env()
    cmd = ["dart", "create", "--force", "-t", "package", env_dir]
    if verbose:
        print(f"  $ {' '.join(cmd)}")
    res = subprocess.run(cmd, capture_output=True, text=True, env=subprocess_env(cfg))
    if verbose:
        _echo(res.stdout, res.stderr)
    if res.returncode != 0:
        # A negative returncode means the child was killed by a signal, leaving
        # stderr empty — fall back to the signal name so the warning isn't blank.
        detail = _last_line(res.stderr) or _signal_detail(res.returncode) or "unknown error"
        print(
            f"Warning: could not scaffold Dart package: {detail}",
            file=sys.stderr,
        )


def _ensure_dart_version(pkg_dir, dart_version, cfg=None, verbose=False):
    """Record the dart version the test package expects (host-provided SDK)."""
    cfg = cfg or resolve_env()
    print(f"Ensuring dart=={dart_version} in the test environment...")
    cmd = ["dart", "--version"]
    if verbose:
        print(f"  $ {' '.join(cmd)}")
    res = subprocess.run(cmd, capture_output=True, text=True, env=subprocess_env(cfg))
    if verbose:
        _echo(res.stdout, res.stderr)
    if res.returncode != 0:
        # A negative returncode means the child was killed by a signal, leaving
        # stderr empty — fall back to the signal name so the warning isn't blank.
        detail = _last_line(res.stderr) or _signal_detail(res.returncode) or "unknown error"
        print(
            f"Warning: could not confirm dart=={dart_version}: {detail}",
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
    """True if pub ``options`` already carry a ``--verbose`` flag."""
    return any(o == "--verbose" for o in options)


def _stream(cmd, env, cwd=None):
    """Run ``cmd``, echoing combined output live while capturing it.

    Returns ``(returncode, combined_output)``. Used in verbose mode so the user
    watches pub in real time (e.g. a slow resolve or a hang) yet the captured
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


def test_installations(pkg_dir, package, index_url, versions, output_json,
                       first_only=False, cfg=None, verbose=False):
    """Attempt to add each version; write an incremental JSON report.

    Each version is added via ``dart pub add <pkg>:<ver>`` inside a throwaway
    temp Dart package, success classified on returncode. Returns the list of
    result dicts. If ``first_only`` is set, stops after the first version that
    installs successfully. When ``verbose`` is set, pub's full output is streamed
    live (and ``--verbose`` is added if none is present) so install failures can
    be debugged; the captured output is also folded into the report under
    ``log``/``error``.
    """
    cfg = cfg or resolve_env()
    env = subprocess_env(cfg)
    options = pub_options(cfg)
    results = []
    installable = []

    for idx, version in enumerate(versions, start=1):
        target = f"{package}:{version}"
        print(f"[{idx}/{len(versions)}] Attempting to install: {target}...")

        # A fresh temp package per version keeps `dart pub add` hermetic and
        # avoids one version's constraint pinning the next.
        tmp_pkg = tempfile.mkdtemp(prefix="dart-itest-", dir=pkg_dir)
        _dart_create(tmp_pkg, cfg, verbose=verbose)

        cmd = ["dart", "pub", "add", target]
        cmd += options
        # Bump pub's verbosity if the user wants detail and nothing already set it.
        if verbose and not _has_verbose(options):
            cmd.append("--verbose")

        if verbose:
            print(f"  $ (cd {tmp_pkg} && {' '.join(cmd)})")
            returncode, output = _stream(cmd, env, cwd=tmp_pkg)
            stdout_text = stderr_text = output  # streamed combined; same text both ways
        else:
            res = subprocess.run(cmd, capture_output=True, text=True, env=env, cwd=tmp_pkg)
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
        description="Find installable versions of a package from a Dart pub registry.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("package", help="Package name to probe (e.g. http).")
    p.add_argument(
        "--hosted-url",
        dest="index_url",
        default=None,
        help="Custom pub hosted server URL. Defaults to $PUB_HOSTED_URL, "
             "then $DART_REGISTRY_URL, then https://pub.dev.",
    )
    p.add_argument(
        "--package-dir",
        dest="venv_dir",
        default=".dart-test-install",
        help="Directory for the isolated test Dart package.",
    )
    p.add_argument(
        "--dart-version",
        default=DEFAULT_DART_VERSION,
        help="dart version to expect in the test package ('none' to skip the check).",
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
        help="Stream full pub output for every step so failures are debuggable.",
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
          f"(registry: {cfg['DART_REGISTRY_NAME']}).")
    dart_version = None if str(args.dart_version).lower() == "none" else args.dart_version
    pkg_dir = setup_venv(args.venv_dir, dart_version, cfg, verbose=args.verbose)
    test_installations(
        pkg_dir,
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
# Example — probe the newest 5 versions of http, stop at the first installable:
#     main(["http", "--hosted-url", "https://pub.dev",
#           "--limit", "5", "--first-only"])
#
# Equivalent on the command line:
#     python3 main.py http \
#         --hosted-url https://pub.dev --limit 5 --first-only

if __name__ == "__main__":
    raise SystemExit(main())  # argv=None -> parse_args reads sys.argv
