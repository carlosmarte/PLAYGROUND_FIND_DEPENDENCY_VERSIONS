#!/usr/bin/env python3
"""Find installable versions of a box from a (custom) Vagrant Cloud.

Discovers every version Vagrant Cloud advertises for a box via the Vagrant Cloud
v1 REST API (``/api/v1/box/<user>/<box>``), then attempts to add each one into
an isolated scratch ``VAGRANT_HOME``, recording success/failure per version to a
JSON report.

Example:
    python main.py hashicorp/bionic64 \
        --vagrant-server https://app.vagrantup.com

    # only probe the newest 5 versions, stop at the first that installs
    python main.py hashicorp/bionic64 --vagrant-server https://app.vagrantup.com \
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

# vagrant version the test environment is pinned to by default. Install-tests run
# against this vagrant, so it governs box add / provider behaviour. Override via
# --vagrant-version (CLI) or the `vagrant` command (REPL).
DEFAULT_VAGRANT_VERSION = "2.4.1"

# Environment knobs read via os.environ.get, each falling back to the value the
# Vagrant / TLS ecosystem uses by default ("industry standard"). vagrant itself
# auto-reads some of these from the environment; we resolve them explicitly so
# the documented default still applies when the var is unset, and so they can be
# surfaced (REPL `env`) and threaded into every vagrant invocation we build.
ENV_DEFAULTS = {
    "VAGRANT_LOG": "",                                  # vagrant: log level (empty = quiet)
    "VAGRANT_DEFAULT_PROVIDER": "virtualbox",           # vagrant: default provider
    "VAGRANT_SERVER_URL": "https://app.vagrantup.com",  # vagrant: Cloud server URL
    "VAGRANT_NO_COLOR": "1",                            # vagrant: plain output for logs
    "VAGRANT_BOX_TIMEOUT": "60",                        # our: socket timeout (seconds)
    "VAGRANT_BOX_RETRIES": "3",                         # our: connection retries
    "VAGRANT_REGISTRY_URL": "https://app.vagrantup.com",  # our vagrant-server fallback
    "VAGRANT_REGISTRY_NAME": "Vagrant Cloud",           # registry display name
    "REQUESTS_CA_BUNDLE": "",                           # requests/urllib3: certifi
    "SSL_CERT_FILE": "",                               # OpenSSL: system CA file
    "SSL_CERT_DIR": "",                               # OpenSSL: system CA dir
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


def resolve_vagrant_server(explicit, cfg=None):
    """Pick the Vagrant server: explicit flag > VAGRANT_SERVER_URL > VAGRANT_REGISTRY_URL."""
    cfg = cfg or resolve_env()
    return explicit or cfg["VAGRANT_SERVER_URL"] or cfg["VAGRANT_REGISTRY_URL"] or None


def vagrant_options(cfg):
    """Translate resolved config into vagrant command-line flags."""
    opts = []
    provider = cfg["VAGRANT_DEFAULT_PROVIDER"]
    if provider:
        opts += ["--provider", provider]
    return opts


def subprocess_env(cfg):
    """Child-process environment with resolved TLS cert + Vagrant vars applied."""
    env = os.environ.copy()
    for name in _TLS_ENV_VARS:
        if cfg[name]:
            env[name] = cfg[name]
    server = resolve_vagrant_server(None, cfg)
    if server:
        env["VAGRANT_SERVER_URL"] = server
    if cfg["VAGRANT_LOG"]:
        env["VAGRANT_LOG"] = cfg["VAGRANT_LOG"]
    if cfg["VAGRANT_NO_COLOR"] not in ("", "0", "false", "False"):
        env["VAGRANT_NO_COLOR"] = "1"
    return env


def get_available_versions(package, vagrant_server, cfg=None, verbose=False):
    """Return the list of versions Vagrant Cloud advertises for ``package``.

    ``package`` is a ``user/box`` box identifier. Versions are returned
    newest-first via the Vagrant Cloud v1 REST API (``/api/v1/box/<user>/<box>``,
    ``versions[].version``). When ``verbose`` is set, the URL and raw output are
    echoed so a failed or empty discovery can be debugged.
    """
    cfg = cfg or resolve_env()
    print(f"Retrieving versions for '{package}' from {vagrant_server}...")
    user, _, box = package.partition("/")
    if not user or not box:
        print("Box must be in 'user/box' form.", file=sys.stderr)
        return []

    base = (vagrant_server or cfg["VAGRANT_SERVER_URL"]).rstrip("/")
    url = f"{base}/api/v1/box/{user}/{box}"
    if verbose:
        print(f"  $ GET {url}")

    try:
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=int(cfg["VAGRANT_BOX_TIMEOUT"])) as resp:
            payload = resp.read().decode("utf-8")
    except (urllib.error.URLError, OSError, ValueError) as e:
        if verbose:
            _echo(str(e))
        print(f"Error querying Vagrant Cloud: {e}", file=sys.stderr)
        sys.exit(1)

    if verbose:
        _echo(payload)
    try:
        data = json.loads(payload)
    except json.JSONDecodeError:
        print("Could not parse Vagrant Cloud JSON response.", file=sys.stderr)
        return []
    # versions[].version, already newest-first from the Vagrant Cloud API.
    return [entry["version"] for entry in data.get("versions", []) if entry.get("version")]


def setup_venv(env_dir, vagrant_version=DEFAULT_VAGRANT_VERSION, cfg=None, verbose=False):
    """Create a fresh sandbox VAGRANT_HOME if needed; return its path.

    For Vagrant the "isolated test environment" is a scratch ``VAGRANT_HOME``
    directory; each ``vagrant box add`` lands its boxes under it without touching
    the host's ``~/.vagrant.d``. ``vagrant_version`` is recorded (and verified,
    best-effort) so install-tests run against a known vagrant. Pass
    ``vagrant_version=None`` to keep whatever vagrant is on PATH. ``verbose``
    echoes the version check so a mismatch can be debugged.
    """
    cfg = cfg or resolve_env()
    if not os.path.exists(env_dir):
        print(f"Creating sandbox VAGRANT_HOME at: {env_dir}")
        os.makedirs(env_dir, exist_ok=True)

    vagrant_home = env_dir  # used as VAGRANT_HOME for each box add

    if vagrant_version:
        _ensure_vagrant_version(vagrant_version, cfg, verbose=verbose)
    return vagrant_home


def _ensure_vagrant_version(vagrant_version, cfg=None, verbose=False):
    """Verify the vagrant on PATH matches ``vagrant_version`` (best effort)."""
    cfg = cfg or resolve_env()
    print(f"Ensuring vagrant=={vagrant_version} in the test environment...")
    cmd = ["vagrant", "--version"]
    if verbose:
        print(f"  $ {' '.join(cmd)}")
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, env=subprocess_env(cfg))
    except FileNotFoundError:
        print("Warning: vagrant not found on PATH.", file=sys.stderr)
        return
    if verbose:
        _echo(res.stdout, res.stderr)
    if res.returncode != 0:
        # A negative returncode means the child was killed by a signal, leaving
        # stderr empty — fall back to the signal name so the warning isn't blank.
        detail = _last_line(res.stderr) or _signal_detail(res.returncode) or "unknown error"
        print(
            f"Warning: could not verify vagrant=={vagrant_version}: {detail}",
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
    """True if vagrant ``options`` already carry a ``--debug``/``-v`` flag."""
    return any(o.startswith("-v") or o == "--debug" for o in options)


def _stream(cmd, env):
    """Run ``cmd``, echoing combined output live while capturing it.

    Returns ``(returncode, combined_output)``. Used in verbose mode so the user
    watches vagrant in real time (e.g. a slow download or a hang) yet the
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


def test_installations(vagrant_home, package, vagrant_server, versions, output_json,
                       first_only=False, cfg=None, verbose=False):
    """Attempt to add each version; write an incremental JSON report.

    Returns the list of result dicts. If ``first_only`` is set, stops after
    the first version that installs successfully. When ``verbose`` is set,
    vagrant's full output is streamed live (and a ``--debug`` flag is added if
    none is present) so failures can be debugged; the captured output is also
    folded into the report under ``log``/``error``.
    """
    cfg = cfg or resolve_env()
    options = vagrant_options(cfg)
    results = []
    installable = []

    for idx, version in enumerate(versions, start=1):
        target = f"{package} @ {version}"
        print(f"[{idx}/{len(versions)}] Attempting to install: {target}...")

        # Add into a throwaway VAGRANT_HOME per version so a successful add of
        # one does not satisfy/shadow the next.
        with tempfile.TemporaryDirectory(prefix="vagrant-", dir=vagrant_home) as tmp:
            env = subprocess_env(cfg)
            env["VAGRANT_HOME"] = tmp
            cmd = [
                "vagrant",
                "box",
                "add",
                package,
                "--box-version",
                version,
                "--force",
            ]
            cmd += options
            # Bump verbosity if the user wants detail and nothing already set it.
            if verbose and not _has_verbose(options):
                cmd.append("--debug")

            if verbose:
                print(f"  $ VAGRANT_HOME={tmp} {' '.join(cmd)}")
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
        description="Find installable versions of a box from a Vagrant Cloud.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("package", help="Box to probe in 'user/box' form (e.g. hashicorp/bionic64).")
    p.add_argument(
        "--vagrant-server",
        default=None,
        help="Custom Vagrant Cloud server URL. Defaults to $VAGRANT_SERVER_URL, "
             "then $VAGRANT_REGISTRY_URL, then https://app.vagrantup.com.",
    )
    p.add_argument(
        "--venv-dir",
        default=".venv-test-install",
        help="Directory for the isolated sandbox VAGRANT_HOME.",
    )
    p.add_argument(
        "--vagrant-version",
        default=DEFAULT_VAGRANT_VERSION,
        help="vagrant version to expect in the test env ('none' to use whatever is on PATH).",
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
        help="Stream full vagrant output for every step so failures are debuggable.",
    )
    return p.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)

    cfg = resolve_env()
    vagrant_server = resolve_vagrant_server(args.vagrant_server, cfg)

    versions = get_available_versions(args.package, vagrant_server, cfg, verbose=args.verbose)
    if not versions:
        print("No versions found. Exiting.")
        return 1

    if args.limit is not None:
        versions = versions[: args.limit]

    print(f"Found {len(versions)} version(s) to test "
          f"(registry: {cfg['VAGRANT_REGISTRY_NAME']}).")
    vagrant_version = None if str(args.vagrant_version).lower() == "none" else args.vagrant_version
    vagrant_home = setup_venv(args.venv_dir, vagrant_version, cfg, verbose=args.verbose)
    test_installations(
        vagrant_home,
        args.package,
        vagrant_server,
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
# Example — probe the newest 5 versions of hashicorp/bionic64, stop at the first installable:
#     main(["hashicorp/bionic64", "--vagrant-server", "https://app.vagrantup.com",
#           "--limit", "5", "--first-only"])
#
# Equivalent on the command line:
#     python3 main.py hashicorp/bionic64 \
#         --vagrant-server https://app.vagrantup.com --limit 5 --first-only

if __name__ == "__main__":
    raise SystemExit(main())  # argv=None -> parse_args reads sys.argv
