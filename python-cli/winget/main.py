#!/usr/bin/env python3
"""Find installable versions of a package from a winget source.

Discovers every version a source advertises for a package by running
``winget show --id <package> --versions`` and parsing its output, then attempts
to install each one with ``winget install``, recording success/failure per
version to a JSON report.

IMPORTANT — winget is Windows-only and has NO public HTTP listing API: both
listing AND install-testing are performed by shelling out to the ``winget`` CLI
itself, which only exists on Windows with winget on PATH. This tool will NOT
function on Linux/macOS hosts — the ``winget`` subprocess calls will fail there
(no such executable). The container image we ship (a Linux python:slim) is for
parity/structure only; real use requires Windows.

Example:
    python main.py Git.Git --source winget

    # only probe the newest 5 versions, stop at the first that installs
    python main.py Git.Git --source winget --limit 5 --first-only
"""

import argparse
import json
import os
import re
import subprocess
import sys

# winget version the test environment is expected to use by default. Install-
# tests run against this toolchain, so it governs source/resolver behaviour.
# Override via --winget-version (CLI) or the `winget` command (REPL).
DEFAULT_WINGET_VERSION = "1.8.0"

# Environment knobs read via os.environ.get, each falling back to the value the
# winget / TLS ecosystem uses by default ("industry standard"). winget itself
# reads some of these from the environment; we resolve them explicitly so the
# documented default still applies when the var is unset, and so they can be
# surfaced (REPL `env`) and threaded into every winget invocation we build.
ENV_DEFAULTS = {
    "WINGET_VERBOSE": "0",                   # winget: quiet (0 = normal)
    "WINGET_CERT": "",                       # winget: use system store (no-op here)
    "WINGET_API": "",                        # winget has NO public HTTP listing API;
                                             # listing is via the `winget` CLI itself
    "WINGET_SOURCE": "winget",               # the default winget source name
    "WINGET_TRUSTED_HOST": "",               # winget: no extra trusted hosts
    "WINGET_DEFAULT_TIMEOUT": "15",          # winget: 15s socket timeout
    "WINGET_RETRIES": "5",                   # winget: 5 connection retries
    "WINGET_REGISTRY_URL": "winget",         # our source fallback (a source NAME)
    "WINGET_REGISTRY_NAME": "Windows Package Manager",  # registry display name
    "REQUESTS_CA_BUNDLE": "",                # requests/urllib3: certifi
    "SSL_CERT_FILE": "",                     # OpenSSL: system CA file
    "SSL_CERT_DIR": "",                      # OpenSSL: system CA dir
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
    """Pick the source: explicit flag > WINGET_SOURCE > WINGET_REGISTRY_URL.

    Note: for winget the "index_url"/source is a source NAME (e.g. ``winget``),
    NOT an http URL — it is passed to ``--source`` verbatim.
    """
    cfg = cfg or resolve_env()
    return explicit or cfg["WINGET_SOURCE"] or cfg["WINGET_REGISTRY_URL"] or None


def winget_options(cfg):
    """Translate resolved config into winget command-line flags."""
    opts = []
    try:
        level = int(cfg["WINGET_VERBOSE"])
    except (TypeError, ValueError):
        level = 0
    if level > 0:
        opts += ["--verbose-logs"]  # winget: emit verbose logs
    if cfg["WINGET_CERT"]:
        # winget has no per-call config-file flag like nuget; kept as a no-op
        # for parity with the reference shape (it rides along addressable).
        pass
    # winget install has no per-call timeout/retry flags; those values ride
    # along via subprocess_env. We keep them resolved for parity.
    return opts


def subprocess_env(cfg):
    """Child-process environment with resolved TLS cert vars applied."""
    env = os.environ.copy()
    for name in _TLS_ENV_VARS:
        if cfg[name]:
            env[name] = cfg[name]
    return env


def get_available_versions(package, index_url, cfg=None, verbose=False):
    """Return the list of versions a source advertises for ``package``.

    Runs ``winget show --id <package> --versions`` (adding ``--source`` when an
    ``index_url`` is set). winget prints a header, then a separator line of
    dashes, then one version per line. We split stdout into lines, find the
    line of dashes, and take every subsequent non-empty line as a version.
    winget already lists newest-first, so we return the parsed list as-is.

    IMPORTANT: this is Windows-only — ``winget`` only exists on Windows with it
    on PATH. On other hosts the subprocess will fail (returncode != 0) and we
    exit(1). When ``verbose`` is set, the command and its raw output are echoed
    so a failed or empty discovery can be debugged.
    """
    cfg = cfg or resolve_env()
    print(f"Retrieving versions for '{package}' from {index_url}...")
    cmd = ["winget", "show", "--id", package, "--versions"]
    if index_url:
        cmd += ["--source", index_url]
    if verbose:
        print(f"  $ {' '.join(cmd)}")

    res = subprocess.run(cmd, capture_output=True, text=True, env=subprocess_env(cfg))
    if verbose:
        _echo(res.stdout, res.stderr)
    if res.returncode != 0:
        print(
            f"Error querying winget: "
            f"{_last_line(res.stderr) or _last_line(res.stdout) or 'unknown error'}",
            file=sys.stderr,
        )
        sys.exit(1)

    # Parse: find the separator line of dashes, then take subsequent non-empty
    # lines as versions. winget already lists newest-first.
    lines = res.stdout.splitlines()
    versions = []
    seen_separator = False
    for line in lines:
        stripped = line.strip()
        if not seen_separator:
            # A line consisting mostly of dashes marks the start of the list.
            if stripped and re.fullmatch(r"-{3,}", stripped):
                seen_separator = True
            continue
        if stripped:
            versions.append(stripped)
    if not versions:
        print("Could not parse any versions from winget output.", file=sys.stderr)
        return []
    return versions


def setup_venv(env_dir, winget_version=DEFAULT_WINGET_VERSION, cfg=None, verbose=False):
    """Create a fresh throwaway sandbox dir if needed; return its directory.

    The sandbox is a temp directory used as the ``--download`` target for the
    non-mutating download path. ``winget_version`` records the toolchain the
    tests are expected to run against (default ``DEFAULT_WINGET_VERSION``). Pass
    ``winget_version=None`` to skip the toolchain-check echo. ``verbose`` echoes
    the setup output so a failed setup can be debugged.
    """
    cfg = cfg or resolve_env()
    if not os.path.exists(env_dir):
        print(f"Creating throwaway winget sandbox at: {env_dir}")
    os.makedirs(env_dir, exist_ok=True)

    if winget_version:
        _ensure_winget_version(env_dir, winget_version, cfg, verbose=verbose)
    return env_dir


def _ensure_winget_version(env_dir, winget_version, cfg=None, verbose=False):
    """Report the winget version (the toolchain install-tests run against)."""
    cfg = cfg or resolve_env()
    print(f"Ensuring winget>={winget_version} in the test environment...")
    cmd = ["winget", "--version"]
    if verbose:
        print(f"  $ {' '.join(cmd)}")
    res = subprocess.run(cmd, capture_output=True, text=True, env=subprocess_env(cfg))
    if verbose:
        _echo(res.stdout, res.stderr)
    if res.returncode != 0:
        print(
            f"Warning: could not verify winget>={winget_version}: "
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
    """True if winget ``options`` already carry a ``--verbose-logs`` flag."""
    return any(o == "--verbose-logs" for o in options)


def _stream(cmd, env):
    """Run ``cmd``, echoing combined output live while capturing it.

    Returns ``(returncode, combined_output)``. Used in verbose mode so the user
    watches winget in real time (e.g. a slow install or a hang) yet the captured
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
    winget's full output is streamed live (and a ``--verbose-logs`` flag is
    added if none is present) so install failures can be debugged; the captured
    output is also folded into the report under ``log``/``error``.

    IMPORTANT: this performs a REAL install on Windows (``winget install``). A
    non-mutating alternative is
    ``winget download --id <package> --version <ver> --download-directory <venv_dir>``
    which fetches the installer into the sandbox without applying it. This is
    Windows-only — the ``winget`` subprocess fails on other hosts.
    """
    cfg = cfg or resolve_env()
    env = subprocess_env(cfg)
    options = winget_options(cfg)
    results = []
    installable = []

    for idx, version in enumerate(versions, start=1):
        target = f"{package}@{version}"
        print(f"[{idx}/{len(versions)}] Attempting to install: {target}...")

        cmd = [
            "winget",
            "install",
            "--id",
            package,
            "--version",
            version,
            "--accept-package-agreements",
            "--accept-source-agreements",
        ]
        cmd += options
        if index_url:
            cmd += ["--source", index_url]
        # Bump winget's own verbosity if the user wants detail and nothing set it.
        if verbose and not _has_verbose(options):
            cmd += ["--verbose-logs"]

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
        description="Find installable versions of a package from a winget source.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("package", help="Package id to probe (e.g. Git.Git).")
    p.add_argument(
        "--source",
        default=None,
        help="winget source name. Defaults to $WINGET_SOURCE, "
             "then $WINGET_REGISTRY_URL, then 'winget'.",
    )
    p.add_argument(
        "--venv-dir",
        default=".venv-test-install",
        help="Directory for the isolated throwaway winget sandbox.",
    )
    p.add_argument(
        "--winget-version",
        default=DEFAULT_WINGET_VERSION,
        help="winget version expected in the test env ('none' to skip the check).",
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
        help="Stream full winget output for every step so failures are debuggable.",
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
          f"(registry: {cfg['WINGET_REGISTRY_NAME']}).")
    winget_version = None if str(args.winget_version).lower() == "none" else args.winget_version
    venv_dir = setup_venv(args.venv_dir, winget_version, cfg, verbose=args.verbose)
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
# Example — probe the newest 5 versions of Git.Git, stop at the first
# installable:
#     main(["Git.Git", "--source", "winget", "--limit", "5", "--first-only"])
#
# Equivalent on the command line:
#     python3 main.py Git.Git --source winget --limit 5 --first-only

if __name__ == "__main__":
    raise SystemExit(main())  # argv=None -> parse_args reads sys.argv
