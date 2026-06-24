#!/usr/bin/env python3
"""Find installable versions of a package from a (custom) NuGet registry.

Discovers every version a registry advertises for a package via the NuGet
flat-container API (``/v3-flatcontainer/<id>/index.json``), then attempts to
install each one into an isolated throwaway .NET project, recording
success/failure per version to a JSON report.

Example:
    python main.py Newtonsoft.Json \
        --source https://api.nuget.org/v3/index.json

    # only probe the newest 5 versions, stop at the first that installs
    python main.py Newtonsoft.Json --source https://api.nuget.org/v3/index.json \
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

# dotnet/nuget tool version the test environment is expected to use by default.
# Install-tests run against this toolchain, so it governs restore/resolver
# behaviour. Override via --dotnet-version (CLI) or the `dotnet` command (REPL).
DEFAULT_DOTNET_VERSION = "8.0"

# Environment knobs read via os.environ.get, each falling back to the value the
# .NET / NuGet / TLS ecosystem uses by default ("industry standard"). dotnet
# itself auto-reads NUGET_* / DOTNET_* vars from the environment; we resolve
# them explicitly so the documented default still applies when the var is unset,
# and so they can be surfaced (REPL `env`) and threaded into every dotnet/nuget
# invocation we build.
ENV_DEFAULTS = {
    "NUGET_VERBOSE": "0",                                  # nuget: quiet (0 = normal)
    "NUGET_CERT": "",                                      # nuget: use system store
    "NUGET_API": "https://api.nuget.org/v3-flatcontainer",  # flat-container base for listing
    "NUGET_SOURCE": "https://api.nuget.org/v3/index.json",  # v3 service index for restore
    "NUGET_TRUSTED_HOST": "",                              # nuget: no extra trusted hosts
    "NUGET_DEFAULT_TIMEOUT": "15",                         # nuget: 15s socket timeout
    "NUGET_RETRIES": "5",                                  # nuget: 5 connection retries
    "DOTNET_REGISTRY_URL": "https://api.nuget.org/v3/index.json",  # our source fallback
    "DOTNET_REGISTRY_NAME": "NuGet.org",                  # registry display name
    "REQUESTS_CA_BUNDLE": "",                             # requests/urllib3: certifi
    "SSL_CERT_FILE": "",                                  # OpenSSL: system CA file
    "SSL_CERT_DIR": "",                                   # OpenSSL: system CA dir
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
    """Pick the source URL: explicit flag > NUGET_SOURCE > DOTNET_REGISTRY_URL."""
    cfg = cfg or resolve_env()
    return explicit or cfg["NUGET_SOURCE"] or cfg["DOTNET_REGISTRY_URL"] or None


def nuget_options(cfg):
    """Translate resolved config into dotnet/nuget command-line flags."""
    opts = []
    try:
        level = int(cfg["NUGET_VERBOSE"])
    except (TypeError, ValueError):
        level = 0
    if level > 0:
        opts += ["--verbosity", "detailed"]  # dotnet: bump restore verbosity
    if cfg["NUGET_CERT"]:
        opts += ["--configfile", cfg["NUGET_CERT"]]
    # dotnet add/restore has no per-call timeout/retry flags; NuGet reads them
    # from the environment, so they ride along via subprocess_env. We still keep
    # the resolved values addressable for parity with the reference shape.
    return opts


def subprocess_env(cfg):
    """Child-process environment with resolved TLS cert + NuGet vars applied."""
    env = os.environ.copy()
    for name in _TLS_ENV_VARS:
        if cfg[name]:
            env[name] = cfg[name]
    # NuGet honours these from the environment; thread the resolved values in.
    env["NUGET_DEFAULT_TIMEOUT"] = str(cfg["NUGET_DEFAULT_TIMEOUT"])
    env["NUGET_RETRIES"] = str(cfg["NUGET_RETRIES"])
    return env


def get_available_versions(package, index_url, cfg=None, verbose=False):
    """Return the list of versions a registry advertises for ``package``.

    Versions are returned newest-first. The NuGet flat-container index lists
    versions oldest-first (``versions[]``), so we reverse it. When ``verbose``
    is set, the API URL and its raw payload are echoed so a failed or empty
    discovery can be debugged.
    """
    cfg = cfg or resolve_env()
    print(f"Retrieving versions for '{package}' from {index_url}...")
    # The flat-container resource keys its index by the lower-cased package id.
    api = cfg["NUGET_API"].rstrip("/")
    url = f"{api}/{package.lower()}/index.json"
    if verbose:
        print(f"  $ GET {url}")

    try:
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=int(cfg["NUGET_DEFAULT_TIMEOUT"])) as resp:
            payload = resp.read().decode("utf-8")
    except Exception as e:  # urllib raises a zoo of errors; treat all as fatal here
        if verbose:
            _echo(str(e))
        print(f"Error querying NuGet flat-container: {e}", file=sys.stderr)
        sys.exit(1)

    if verbose:
        _echo(payload)
    try:
        data = json.loads(payload)
    except json.JSONDecodeError:
        print("Could not parse JSON from NuGet flat-container.", file=sys.stderr)
        return []
    versions = data.get("versions")
    if not versions:
        print("Could not find 'versions' in NuGet flat-container index.", file=sys.stderr)
        return []
    # API lists oldest-first; reverse so callers get newest-first.
    return [v.strip() for v in reversed(versions) if v.strip()]


def setup_venv(env_dir, dotnet_version=DEFAULT_DOTNET_VERSION, cfg=None, verbose=False):
    """Create a fresh throwaway .NET project if needed; return its directory.

    The sandbox is a ``dotnet new classlib`` project into which each version is
    added with ``dotnet add package``. ``dotnet_version`` records the toolchain
    the tests are expected to run against (default ``DEFAULT_DOTNET_VERSION``).
    Pass ``dotnet_version=None`` to skip the toolchain-check echo. ``verbose``
    echoes the project-scaffold output so a failed setup can be debugged.
    """
    cfg = cfg or resolve_env()
    if not os.path.exists(env_dir):
        print(f"Creating throwaway .NET project at: {env_dir}")
        os.makedirs(env_dir, exist_ok=True)
        cmd = ["dotnet", "new", "classlib", "-o", env_dir]
        if verbose:
            print(f"  $ {' '.join(cmd)}")
        res = subprocess.run(cmd, capture_output=True, text=True, env=subprocess_env(cfg))
        if verbose:
            _echo(res.stdout, res.stderr)
        if res.returncode != 0:
            # A negative returncode means the child was killed by a signal,
            # leaving stderr empty — fall back to the signal name, not blank.
            detail = _last_line(res.stderr)
            if not detail and res.returncode is not None and res.returncode < 0:
                try:
                    detail = f"terminated by signal {signal.Signals(-res.returncode).name}"
                except ValueError:
                    detail = f"terminated by signal {-res.returncode}"
            print(
                f"Warning: could not scaffold the .NET project: "
                f"{detail or 'unknown error'}",
                file=sys.stderr,
            )

    if dotnet_version:
        _ensure_dotnet_version(env_dir, dotnet_version, cfg, verbose=verbose)
    return env_dir


def _ensure_dotnet_version(env_dir, dotnet_version, cfg=None, verbose=False):
    """Report the dotnet SDK version (the toolchain install-tests run against)."""
    cfg = cfg or resolve_env()
    print(f"Ensuring dotnet>={dotnet_version} in the test environment...")
    cmd = ["dotnet", "--version"]
    if verbose:
        print(f"  $ {' '.join(cmd)}")
    res = subprocess.run(cmd, capture_output=True, text=True, env=subprocess_env(cfg))
    if verbose:
        _echo(res.stdout, res.stderr)
    if res.returncode != 0:
        # A negative returncode means the child was killed by a signal, leaving
        # stderr empty — fall back to the signal name so the failure isn't blank.
        detail = _last_line(res.stderr)
        if not detail and res.returncode is not None and res.returncode < 0:
            try:
                detail = f"terminated by signal {signal.Signals(-res.returncode).name}"
            except ValueError:
                detail = f"terminated by signal {-res.returncode}"
        print(
            f"Warning: could not verify dotnet>={dotnet_version}: "
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
    """True if dotnet ``options`` already carry a ``--verbosity`` flag."""
    return any(o == "--verbosity" for o in options)


def _stream(cmd, env):
    """Run ``cmd``, echoing combined output live while capturing it.

    Returns ``(returncode, combined_output)``. Used in verbose mode so the user
    watches dotnet in real time (e.g. a slow restore or a hang) yet the captured
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
    dotnet's full output is streamed live (and a ``--verbosity detailed`` flag is
    added if none is present) so install failures can be debugged; the captured
    output is also folded into the report under ``log``/``error``.
    """
    cfg = cfg or resolve_env()
    env = subprocess_env(cfg)
    options = nuget_options(cfg)
    results = []
    installable = []

    for idx, version in enumerate(versions, start=1):
        target = f"{package}@{version}"
        print(f"[{idx}/{len(versions)}] Attempting to install: {target}...")

        cmd = [
            "dotnet",
            "add",
            venv_dir,
            "package",
            package,
            "--version",
            version,
        ]
        cmd += options
        if index_url:
            cmd += ["--source", index_url]
        # Bump dotnet's own verbosity if the user wants detail and nothing set it.
        if verbose and not _has_verbose(options):
            cmd += ["--verbosity", "detailed"]

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
        description="Find installable versions of a package from a NuGet registry.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("package", help="Package id to probe (e.g. Newtonsoft.Json).")
    p.add_argument(
        "--source",
        default=None,
        help="Custom NuGet v3 service index URL. Defaults to $NUGET_SOURCE, "
             "then $DOTNET_REGISTRY_URL, then https://api.nuget.org/v3/index.json.",
    )
    p.add_argument(
        "--venv-dir",
        default=".venv-test-install",
        help="Directory for the isolated throwaway .NET test project.",
    )
    p.add_argument(
        "--dotnet-version",
        default=DEFAULT_DOTNET_VERSION,
        help="dotnet SDK version expected in the test env ('none' to skip the check).",
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
        help="Stream full dotnet output for every step so failures are debuggable.",
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
          f"(registry: {cfg['DOTNET_REGISTRY_NAME']}).")
    dotnet_version = None if str(args.dotnet_version).lower() == "none" else args.dotnet_version
    venv_dir = setup_venv(args.venv_dir, dotnet_version, cfg, verbose=args.verbose)
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
# Example — probe the newest 5 versions of Newtonsoft.Json, stop at the first
# installable:
#     main(["Newtonsoft.Json", "--source", "https://api.nuget.org/v3/index.json",
#           "--limit", "5", "--first-only"])
#
# Equivalent on the command line:
#     python3 main.py Newtonsoft.Json \
#         --source https://api.nuget.org/v3/index.json --limit 5 --first-only

if __name__ == "__main__":
    raise SystemExit(main())  # argv=None -> parse_args reads sys.argv
