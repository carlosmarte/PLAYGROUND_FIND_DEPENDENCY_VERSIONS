#!/usr/bin/env python3
"""Find installable versions of a module from a (custom) Puppet Forge.

Discovers every version Puppet Forge advertises for a module via the Forge v3
REST API (``/v3/modules/<user>-<mod>``), then attempts to install each one into
an isolated scratch target dir, recording success/failure per version to a JSON
report.

Example:
    python main.py puppetlabs-stdlib \
        --forge-server https://forgeapi.puppet.com

    # only probe the newest 5 versions, stop at the first that installs
    python main.py puppetlabs-stdlib --forge-server https://forgeapi.puppet.com \
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
import urllib.error
import urllib.request

# puppet version the test environment is pinned to by default. Install-tests run
# against this puppet, so it governs module resolution behaviour. Override via
# --puppet-version (CLI) or the `puppet` command (REPL).
DEFAULT_PUPPET_VERSION = "8.10.0"

# Environment knobs read via os.environ.get, each falling back to the value the
# Puppet Forge / TLS ecosystem uses by default ("industry standard"). puppet
# itself auto-reads some of these from the environment; we resolve them
# explicitly so the documented default still applies when the var is unset, and
# so they can be surfaced (REPL `env`) and threaded into every puppet invocation
# we build.
ENV_DEFAULTS = {
    "PUPPET_VERBOSE": "0",                               # puppet: quiet (0 = no --verbose)
    "PUPPET_FORGE_SSL_VERIFY": "1",                      # puppet: verify Forge TLS
    "PUPPET_FORGE_URL": "https://forgeapi.puppet.com",   # puppet: Forge API base
    "PUPPET_FORGE_SERVER": "https://forgeapi.puppet.com",  # puppet: module_repository
    "PUPPET_FORGE_TIMEOUT": "60",                        # our: socket timeout (seconds)
    "PUPPET_FORGE_RETRIES": "3",                         # our: connection retries
    "PUPPET_REGISTRY_URL": "https://forgeapi.puppet.com",  # our forge-server fallback
    "PUPPET_REGISTRY_NAME": "Puppet Forge",              # registry display name
    "REQUESTS_CA_BUNDLE": "",                            # requests/urllib3: certifi
    "SSL_CERT_FILE": "",                                # OpenSSL: system CA file
    "SSL_CERT_DIR": "",                                # OpenSSL: system CA dir
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


def resolve_forge_server(explicit, cfg=None):
    """Pick the Forge server: explicit flag > PUPPET_FORGE_SERVER > PUPPET_REGISTRY_URL."""
    cfg = cfg or resolve_env()
    return explicit or cfg["PUPPET_FORGE_SERVER"] or cfg["PUPPET_REGISTRY_URL"] or None


def puppet_options(cfg):
    """Translate resolved config into puppet command-line flags."""
    opts = []
    try:
        level = int(cfg["PUPPET_VERBOSE"])
    except (TypeError, ValueError):
        level = 0
    if level > 0:
        opts.append("--verbose")  # puppet uses a single --verbose flag
    server = resolve_forge_server(None, cfg)
    if server:
        opts += ["--module_repository", server]
    return opts


def subprocess_env(cfg):
    """Child-process environment with resolved TLS cert vars applied."""
    env = os.environ.copy()
    for name in _TLS_ENV_VARS:
        if cfg[name]:
            env[name] = cfg[name]
    server = resolve_forge_server(None, cfg)
    if server:
        env["PUPPET_FORGE_URL"] = server
    return env


def get_available_versions(package, forge_server, cfg=None, verbose=False):
    """Return the list of versions the Forge advertises for ``package``.

    ``package`` is a ``user-mod`` (or ``user/mod``) module identifier. Versions
    are returned newest-first via the Forge v3 REST API
    (``/v3/modules/<user>-<mod>``, ``releases[].version``). When ``verbose`` is
    set, the URL and raw output are echoed so a failed or empty discovery can be
    debugged.
    """
    cfg = cfg or resolve_env()
    print(f"Retrieving versions for '{package}' from {forge_server}...")
    # The Forge slug uses a dash; accept the puppet-module-install 'user/mod'
    # form too and normalise to 'user-mod' for the API path.
    slug = package.replace("/", "-")
    if "-" not in slug:
        print("Module must be in 'user-mod' (or 'user/mod') form.", file=sys.stderr)
        return []

    base = (forge_server or cfg["PUPPET_FORGE_SERVER"]).rstrip("/")
    url = f"{base}/v3/modules/{slug}"
    if verbose:
        print(f"  $ GET {url}")

    try:
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=int(cfg["PUPPET_FORGE_TIMEOUT"])) as resp:
            payload = resp.read().decode("utf-8")
    except (urllib.error.URLError, OSError, ValueError) as e:
        if verbose:
            _echo(str(e))
        print(f"Error querying Puppet Forge: {e}", file=sys.stderr)
        sys.exit(1)

    if verbose:
        _echo(payload)
    try:
        data = json.loads(payload)
    except json.JSONDecodeError:
        print("Could not parse Puppet Forge JSON response.", file=sys.stderr)
        return []
    # releases[].version, already newest-first from the Forge API.
    return [entry["version"] for entry in data.get("releases", []) if entry.get("version")]


def setup_venv(env_dir, puppet_version=DEFAULT_PUPPET_VERSION, cfg=None, verbose=False):
    """Create a fresh sandbox target dir if needed; return its path.

    For Puppet the "isolated test environment" is a scratch directory passed to
    ``puppet module install --target-dir <dir>``; each install lands under it
    without touching the host's module paths. ``puppet_version`` is recorded (and
    verified, best-effort) so install-tests run against a known puppet. Pass
    ``puppet_version=None`` to keep whatever puppet is on PATH. ``verbose`` echoes
    the version check so a mismatch can be debugged.
    """
    cfg = cfg or resolve_env()
    if not os.path.exists(env_dir):
        print(f"Creating sandbox target dir at: {env_dir}")
        os.makedirs(env_dir, exist_ok=True)

    target_dir = env_dir  # puppet installs modules under --target-dir <dir>

    if puppet_version:
        _ensure_puppet_version(puppet_version, cfg, verbose=verbose)
    return target_dir


def _ensure_puppet_version(puppet_version, cfg=None, verbose=False):
    """Verify the puppet on PATH matches ``puppet_version`` (best effort)."""
    cfg = cfg or resolve_env()
    print(f"Ensuring puppet=={puppet_version} in the test environment...")
    cmd = ["puppet", "--version"]
    if verbose:
        print(f"  $ {' '.join(cmd)}")
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, env=subprocess_env(cfg))
    except FileNotFoundError:
        print("Warning: puppet not found on PATH.", file=sys.stderr)
        return
    if verbose:
        _echo(res.stdout, res.stderr)
    if res.returncode != 0:
        # A negative returncode means the child was killed by a signal, leaving
        # stderr empty — fall back to the signal name so the warning isn't blank.
        detail = _last_line(res.stderr)
        if not detail and res.returncode < 0:
            try:
                detail = f"terminated by signal {signal.Signals(-res.returncode).name}"
            except ValueError:
                detail = f"terminated by signal {-res.returncode}"
        print(
            f"Warning: could not verify puppet=={puppet_version}: "
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
    """True if puppet ``options`` already carry a ``--verbose``/``--debug`` flag."""
    return any(o in ("--verbose", "--debug") for o in options)


def _stream(cmd, env):
    """Run ``cmd``, echoing combined output live while capturing it.

    Returns ``(returncode, combined_output)``. Used in verbose mode so the user
    watches puppet in real time (e.g. a slow download or a hang) yet the captured
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


def test_installations(target_dir, package, forge_server, versions, output_json,
                       first_only=False, cfg=None, verbose=False):
    """Attempt to install each version; write an incremental JSON report.

    Returns the list of result dicts. If ``first_only`` is set, stops after
    the first version that installs successfully. When ``verbose`` is set,
    puppet's full output is streamed live (and a ``--verbose`` flag is added if
    none is present) so install failures can be debugged; the captured output is
    also folded into the report under ``log``/``error``.
    """
    cfg = cfg or resolve_env()
    env = subprocess_env(cfg)
    options = puppet_options(cfg)
    results = []
    installable = []

    # Normalise the install slug to the Forge 'user-mod' form puppet expects.
    slug = package.replace("/", "-")

    for idx, version in enumerate(versions, start=1):
        target = f"{slug} @ {version}"
        print(f"[{idx}/{len(versions)}] Attempting to install: {target}...")

        # Install into a throwaway target dir per version so a successful install
        # of one does not satisfy/shadow the next.
        with tempfile.TemporaryDirectory(prefix="forge-", dir=target_dir) as tmp:
            cmd = [
                "puppet",
                "module",
                "install",
                slug,
                "--version",
                version,
                "--target-dir",
                tmp,
                "--force",
            ]
            cmd += options
            # Bump verbosity if the user wants detail and nothing already set it.
            if verbose and not _has_verbose(options):
                cmd.append("--verbose")

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
        description="Find installable versions of a module from a Puppet Forge.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("package", help="Module to probe in 'user-mod' form (e.g. puppetlabs-stdlib).")
    p.add_argument(
        "--forge-server",
        default=None,
        help="Custom Forge server URL. Defaults to $PUPPET_FORGE_SERVER, "
             "then $PUPPET_REGISTRY_URL, then https://forgeapi.puppet.com.",
    )
    p.add_argument(
        "--venv-dir",
        default=".venv-test-install",
        help="Directory for the isolated sandbox module target dir.",
    )
    p.add_argument(
        "--puppet-version",
        default=DEFAULT_PUPPET_VERSION,
        help="puppet version to expect in the test env ('none' to use whatever is on PATH).",
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
        help="Stream full puppet output for every step so failures are debuggable.",
    )
    return p.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)

    cfg = resolve_env()
    forge_server = resolve_forge_server(args.forge_server, cfg)

    versions = get_available_versions(args.package, forge_server, cfg, verbose=args.verbose)
    if not versions:
        print("No versions found. Exiting.")
        return 1

    if args.limit is not None:
        versions = versions[: args.limit]

    print(f"Found {len(versions)} version(s) to test "
          f"(registry: {cfg['PUPPET_REGISTRY_NAME']}).")
    puppet_version = None if str(args.puppet_version).lower() == "none" else args.puppet_version
    target_dir = setup_venv(args.venv_dir, puppet_version, cfg, verbose=args.verbose)
    test_installations(
        target_dir,
        args.package,
        forge_server,
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
# Example — probe the newest 5 versions of puppetlabs-stdlib, stop at the first installable:
#     main(["puppetlabs-stdlib", "--forge-server", "https://forgeapi.puppet.com",
#           "--limit", "5", "--first-only"])
#
# Equivalent on the command line:
#     python3 main.py puppetlabs-stdlib \
#         --forge-server https://forgeapi.puppet.com --limit 5 --first-only

if __name__ == "__main__":
    raise SystemExit(main())  # argv=None -> parse_args reads sys.argv
