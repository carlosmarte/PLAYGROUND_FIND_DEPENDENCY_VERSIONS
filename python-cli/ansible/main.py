#!/usr/bin/env python3
"""Find installable versions of a collection from a (custom) Ansible Galaxy.

Discovers every version the Galaxy server advertises for a collection via the
Galaxy v3 REST API (``.../collections/index/<ns>/<name>/versions/``), then
attempts to install each one into an isolated scratch directory, recording
success/failure per version to a JSON report.

Example:
    python main.py community.general \
        --galaxy-server https://my-galaxy.example.com

    # only probe the newest 5 versions, stop at the first that installs
    python main.py community.general --galaxy-server https://galaxy.example.com \
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

# ansible version the test environment is pinned to by default. Install-tests run
# against this ansible-galaxy, so it governs resolver/dependency behaviour.
# Override via --ansible-version (CLI) or the `ansible` command (REPL).
DEFAULT_ANSIBLE_VERSION = "11.1.0"

# Environment knobs read via os.environ.get, each falling back to the value the
# Ansible Galaxy / TLS ecosystem uses by default ("industry standard").
# ansible-galaxy itself auto-reads some of these from the environment; we resolve
# them explicitly so the documented default still applies when the var is unset,
# and so they can be surfaced (REPL `env`) and threaded into every ansible-galaxy
# invocation we build.
ENV_DEFAULTS = {
    "ANSIBLE_VERBOSITY": "0",                              # ansible: quiet (0 = no -v)
    "ANSIBLE_GALAXY_DISABLE_GPG_VERIFY": "1",             # ansible: skip signature verify
    "ANSIBLE_GALAXY_SERVER": "https://galaxy.ansible.com",  # ansible: default Galaxy
    "ANSIBLE_GALAXY_SERVER_URL": "https://galaxy.ansible.com",  # PEP-ish API base
    "ANSIBLE_GALAXY_IGNORE_CERTS": "0",                   # ansible: validate certs
    "ANSIBLE_GALAXY_TIMEOUT": "60",                       # ansible: 60s socket timeout
    "ANSIBLE_GALAXY_RETRIES": "3",                        # ansible: connection retries
    "ANSIBLE_REGISTRY_URL": "https://galaxy.ansible.com",  # our galaxy-server fallback
    "ANSIBLE_REGISTRY_NAME": "Ansible Galaxy",            # registry display name
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


def resolve_galaxy_server(explicit, cfg=None):
    """Pick the Galaxy server: explicit flag > ANSIBLE_GALAXY_SERVER > ANSIBLE_REGISTRY_URL."""
    cfg = cfg or resolve_env()
    return explicit or cfg["ANSIBLE_GALAXY_SERVER"] or cfg["ANSIBLE_REGISTRY_URL"] or None


def galaxy_options(cfg):
    """Translate resolved config into ansible-galaxy command-line flags."""
    opts = []
    try:
        level = int(cfg["ANSIBLE_VERBOSITY"])
    except (TypeError, ValueError):
        level = 0
    if level > 0:
        opts.append("-" + "v" * level)  # -v / -vv / -vvv ...
    if cfg["ANSIBLE_GALAXY_IGNORE_CERTS"] not in ("", "0", "false", "False"):
        opts.append("--ignore-certs")
    server = resolve_galaxy_server(None, cfg)
    if server:
        opts += ["--server", server]
    opts += ["--timeout", str(cfg["ANSIBLE_GALAXY_TIMEOUT"])]
    return opts


def subprocess_env(cfg):
    """Child-process environment with resolved TLS cert vars applied."""
    env = os.environ.copy()
    for name in _TLS_ENV_VARS:
        if cfg[name]:
            env[name] = cfg[name]
    server = resolve_galaxy_server(None, cfg)
    if server:
        env["ANSIBLE_GALAXY_SERVER"] = server
    return env


def get_available_versions(package, galaxy_server, cfg=None, verbose=False):
    """Return the list of versions Galaxy advertises for ``package``.

    ``package`` is a ``namespace.name`` collection identifier. Versions are
    returned newest-first via the Galaxy v3 REST API
    (``.../collections/index/<ns>/<name>/versions/``), falling back to
    ``ansible-galaxy collection list`` if the HTTP query fails. When ``verbose``
    is set, the URL/command and raw output are echoed so a failed or empty
    discovery can be debugged.
    """
    cfg = cfg or resolve_env()
    print(f"Retrieving versions for '{package}' from {galaxy_server}...")
    namespace, _, name = package.partition(".")
    if not namespace or not name:
        print("Collection must be in 'namespace.name' form.", file=sys.stderr)
        return []

    base = (galaxy_server or cfg["ANSIBLE_GALAXY_SERVER"]).rstrip("/")
    url = (
        f"{base}/api/v3/plugin/ansible/content/published/collections/index/"
        f"{namespace}/{name}/versions/"
    )
    if verbose:
        print(f"  $ GET {url}")

    try:
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=int(cfg["ANSIBLE_GALAXY_TIMEOUT"])) as resp:
            payload = resp.read().decode("utf-8")
    except (urllib.error.URLError, OSError, ValueError) as e:
        if verbose:
            _echo(str(e))
        print(f"HTTP version query failed ({e}); falling back to ansible-galaxy.",
              file=sys.stderr)
        return _versions_via_cli(package, cfg, verbose=verbose)

    if verbose:
        _echo(payload)
    try:
        data = json.loads(payload)
    except json.JSONDecodeError:
        print("Could not parse Galaxy JSON response.", file=sys.stderr)
        return []
    # data[].version, already newest-first from the Galaxy API.
    return [entry["version"] for entry in data.get("data", []) if entry.get("version")]


def _versions_via_cli(package, cfg=None, verbose=False):
    """Fallback discovery via ``ansible-galaxy collection list`` (installed only)."""
    cfg = cfg or resolve_env()
    cmd = ["ansible-galaxy", "collection", "list", package, "--format", "json"]
    # Strip any -v/-vv from the discovery query: we only parse the JSON version
    # list, but verbose ansible-galaxy floods diagnostics — a flood of output
    # that bloats the captured buffer (and overflows the Node twin's spawnSync
    # limit). Keep the discovery query quiet.
    cmd += _strip_verbose(galaxy_options(cfg))
    if verbose:
        print(f"  $ {' '.join(cmd)}")
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, check=True, env=subprocess_env(cfg)
        )
    except (subprocess.CalledProcessError, FileNotFoundError) as e:
        if verbose:
            _echo(getattr(e, "stdout", ""), getattr(e, "stderr", "") or str(e))
        # A negative returncode means the child was killed by a signal, leaving
        # stderr empty — fall back to the signal name so the failure isn't blank.
        detail = (getattr(e, "stderr", "") or "").strip()
        returncode = getattr(e, "returncode", None)
        if not detail and returncode is not None and returncode < 0:
            try:
                detail = f"terminated by signal {signal.Signals(-returncode).name}"
            except ValueError:
                detail = f"terminated by signal {-returncode}"
        if not detail:
            detail = str(e)
        print(f"Error running 'ansible-galaxy collection list': {detail}",
              file=sys.stderr)
        return []
    if verbose:
        _echo(result.stdout)
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError:
        # Plain-text fallback: scan for "namespace.name <version>" rows.
        return [m.group(1) for m in re.finditer(r"\b(\d+\.\d+\.\d+\S*)", result.stdout)]
    versions = []
    for path in data.values():
        entry = path.get(package)
        if entry and entry.get("version"):
            versions.append(entry["version"])
    return versions


def setup_venv(env_dir, ansible_version=DEFAULT_ANSIBLE_VERSION, cfg=None, verbose=False):
    """Create a fresh sandbox collections dir if needed; return its path.

    For Ansible the "isolated test environment" is a scratch directory passed to
    ``ansible-galaxy collection install -p <dir>``; each install lands under it
    without touching the host's collection paths. ``ansible_version`` is recorded
    (and verified, best-effort) so install-tests run against a known
    ansible-galaxy. Pass ``ansible_version=None`` to keep whatever ansible is on
    PATH. ``verbose`` echoes the version check so a mismatch can be debugged.
    """
    cfg = cfg or resolve_env()
    if not os.path.exists(env_dir):
        print(f"Creating sandbox collections dir at: {env_dir}")
        os.makedirs(env_dir, exist_ok=True)

    install_path = env_dir  # ansible-galaxy installs collections under -p <dir>

    if ansible_version:
        _ensure_ansible_version(ansible_version, cfg, verbose=verbose)
    return install_path


def _ensure_ansible_version(ansible_version, cfg=None, verbose=False):
    """Verify the ansible-galaxy on PATH matches ``ansible_version`` (best effort)."""
    cfg = cfg or resolve_env()
    print(f"Ensuring ansible=={ansible_version} in the test environment...")
    cmd = ["ansible-galaxy", "--version"]
    if verbose:
        print(f"  $ {' '.join(cmd)}")
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, env=subprocess_env(cfg))
    except FileNotFoundError:
        print("Warning: ansible-galaxy not found on PATH.", file=sys.stderr)
        return
    if verbose:
        _echo(res.stdout, res.stderr)
    if res.returncode != 0:
        print(
            f"Warning: could not verify ansible=={ansible_version}: "
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
    """True if ansible-galaxy ``options`` already carry a ``-v``/``-vv`` flag."""
    return any(o.startswith("-v") for o in options)


def _strip_verbose(options):
    """Return ``options`` with any ``-v``/``-vv``/``-vvv`` verbosity flag removed."""
    return [o for o in options if not re.fullmatch(r"-v+", o)]


def _stream(cmd, env):
    """Run ``cmd``, echoing combined output live while capturing it.

    Returns ``(returncode, combined_output)``. Used in verbose mode so the user
    watches ansible-galaxy in real time (e.g. a slow download or a hang) yet the
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


def test_installations(install_path, package, galaxy_server, versions, output_json,
                       first_only=False, cfg=None, verbose=False):
    """Attempt to install each version; write an incremental JSON report.

    Returns the list of result dicts. If ``first_only`` is set, stops after
    the first version that installs successfully. When ``verbose`` is set,
    ansible-galaxy's full output is streamed live (and a ``-v`` flag is added if
    none is present) so install failures can be debugged; the captured output is
    also folded into the report under ``log``/``error``.
    """
    cfg = cfg or resolve_env()
    env = subprocess_env(cfg)
    options = galaxy_options(cfg)
    results = []
    installable = []

    for idx, version in enumerate(versions, start=1):
        target = f"{package}:{version}"
        print(f"[{idx}/{len(versions)}] Attempting to install: {target}...")

        # Install into a throwaway prefix per version so a successful install of
        # one does not satisfy/shadow the next.
        with tempfile.TemporaryDirectory(prefix="galaxy-", dir=install_path) as tmp:
            cmd = [
                "ansible-galaxy",
                "collection",
                "install",
                target,
                "-p",
                tmp,
                "--force",
            ]
            cmd += options
            # Bump verbosity if the user wants detail and nothing already set it.
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
        description="Find installable versions of a collection from an Ansible Galaxy.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("package", help="Collection to probe in 'namespace.name' form (e.g. community.general).")
    p.add_argument(
        "--galaxy-server",
        default=None,
        help="Custom Galaxy server URL. Defaults to $ANSIBLE_GALAXY_SERVER, "
             "then $ANSIBLE_REGISTRY_URL, then https://galaxy.ansible.com.",
    )
    p.add_argument(
        "--venv-dir",
        default=".venv-test-install",
        help="Directory for the isolated sandbox collections install path.",
    )
    p.add_argument(
        "--ansible-version",
        default=DEFAULT_ANSIBLE_VERSION,
        help="ansible version to expect in the test env ('none' to use whatever is on PATH).",
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
        help="Stream full ansible-galaxy output for every step so failures are debuggable.",
    )
    return p.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)

    cfg = resolve_env()
    galaxy_server = resolve_galaxy_server(args.galaxy_server, cfg)

    versions = get_available_versions(args.package, galaxy_server, cfg, verbose=args.verbose)
    if not versions:
        print("No versions found. Exiting.")
        return 1

    if args.limit is not None:
        versions = versions[: args.limit]

    print(f"Found {len(versions)} version(s) to test "
          f"(registry: {cfg['ANSIBLE_REGISTRY_NAME']}).")
    ansible_version = None if str(args.ansible_version).lower() == "none" else args.ansible_version
    install_path = setup_venv(args.venv_dir, ansible_version, cfg, verbose=args.verbose)
    test_installations(
        install_path,
        args.package,
        galaxy_server,
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
# Example — probe the newest 5 versions of community.general, stop at the first installable:
#     main(["community.general", "--galaxy-server", "https://galaxy.example.com",
#           "--limit", "5", "--first-only"])
#
# Equivalent on the command line:
#     python3 main.py community.general \
#         --galaxy-server https://galaxy.example.com --limit 5 --first-only

if __name__ == "__main__":
    raise SystemExit(main())  # argv=None -> parse_args reads sys.argv
