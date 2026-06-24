#!/usr/bin/env python3
"""Find installable versions of a package from a (custom) npm registry via pnpm.

Discovers every version a registry advertises for a package via
``pnpm view <pkg> versions --json``, then attempts to add each one in an
isolated temp project, recording success/failure per version to a JSON report.

Example:
    python main.py left-pad \
        --registry https://my-registry.example.com

    # only probe the newest 5 versions, stop at the first that installs
    python main.py left-pad --registry https://reg \
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

# pnpm version the test environment is pinned to by default. Install-tests run
# against this pnpm, so it governs resolver/lockfile behaviour. Override via
# --pnpm-version (CLI) or the `pnpm` command (REPL).
DEFAULT_PNPM_VERSION = "9.15.0"

# Environment knobs read via os.environ.get, each falling back to the value the
# Node.js / pnpm / TLS ecosystem uses by default ("industry standard"). pnpm
# itself auto-reads NPM_CONFIG_* vars from the environment; we resolve them
# explicitly so the documented default still applies when the var is unset, and
# so they can be surfaced (REPL `env`) and threaded into every pnpm invocation.
ENV_DEFAULTS = {
    "NPM_CONFIG_LOGLEVEL": "warn",                   # pnpm: log level (warn = quiet)
    "NPM_CONFIG_CAFILE": "",                          # pnpm: use bundled/system CA store
    "NPM_CONFIG_REGISTRY": "https://registry.npmjs.org",  # pnpm: package registry
    "NPM_CONFIG_STRICT_SSL": "true",                  # pnpm: verify TLS certificates
    "NPM_CONFIG_FETCH_TIMEOUT": "300000",             # pnpm: 300s fetch timeout (ms)
    "NPM_CONFIG_FETCH_RETRIES": "2",                  # pnpm: 2 fetch retries
    "NODE_REGISTRY_URL": "https://registry.npmjs.org",  # our registry fallback
    "NODE_REGISTRY_NAME": "pnpm",                     # registry display name
    "NODE_EXTRA_CA_CERTS": "",                        # node: extra CA bundle
    "SSL_CERT_FILE": "",                              # OpenSSL: system CA file
    "SSL_CERT_DIR": "",                               # OpenSSL: system CA dir
}

# TLS vars passed through to child processes via the environment (no CLI flag).
_TLS_ENV_VARS = ("NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR")


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
    """Pick the registry URL: explicit flag > NPM_CONFIG_REGISTRY > NODE_REGISTRY_URL."""
    cfg = cfg or resolve_env()
    return explicit or cfg["NPM_CONFIG_REGISTRY"] or cfg["NODE_REGISTRY_URL"] or None


def pnpm_options(cfg):
    """Translate resolved config into pnpm command-line flags."""
    opts = []
    level = (cfg["NPM_CONFIG_LOGLEVEL"] or "").strip()
    if level:
        opts += ["--loglevel", level]
    if cfg["NPM_CONFIG_CAFILE"]:
        opts += ["--config.cafile", cfg["NPM_CONFIG_CAFILE"]]
    if str(cfg["NPM_CONFIG_STRICT_SSL"]).lower() in ("false", "0", "no"):
        opts += ["--config.strict-ssl", "false"]
    opts += ["--config.fetch-timeout", str(cfg["NPM_CONFIG_FETCH_TIMEOUT"])]
    opts += ["--config.fetch-retries", str(cfg["NPM_CONFIG_FETCH_RETRIES"])]
    return opts


def subprocess_env(cfg):
    """Child-process environment with resolved TLS cert vars applied."""
    env = os.environ.copy()
    for name in _TLS_ENV_VARS:
        if cfg[name]:
            env[name] = cfg[name]
    if cfg["NPM_CONFIG_CAFILE"]:
        env["NPM_CONFIG_CAFILE"] = cfg["NPM_CONFIG_CAFILE"]
    return env


def get_available_versions(package, index_url, cfg=None, verbose=False):
    """Return the list of versions a registry advertises for ``package``.

    Versions are returned newest-first, mirroring how you'd read
    ``pnpm view <pkg> versions --json`` (pnpm returns them oldest-first, so we
    reverse). When ``verbose`` is set, the pnpm command and its raw output are
    echoed so a failed or empty discovery can be debugged.
    """
    cfg = cfg or resolve_env()
    print(f"Retrieving versions for '{package}' from {index_url}...")
    cmd = [
        "pnpm",
        "view",
        package,
        "versions",
        "--json",
    ]
    # Strip any verbose `--loglevel` for this query: we only parse a tiny JSON
    # blob, but a chatty loglevel (verbose/silly/debug) emits a flood of output
    # — a flood that bloats the captured buffer (and overflows the Node twin's
    # spawnSync limit). Keep the discovery query quiet.
    cmd += _strip_verbose(pnpm_options(cfg))
    if index_url:
        cmd += ["--registry", index_url]
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
        print(f"Error running 'pnpm view': {detail or 'unknown error'}", file=sys.stderr)
        sys.exit(1)

    if verbose:
        _echo(result.stdout)
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError:
        print("Could not parse JSON from pnpm output.", file=sys.stderr)
        return []
    # pnpm yields a JSON string for a single version, or a JSON array for many.
    if isinstance(data, str):
        versions = [data]
    elif isinstance(data, list):
        versions = [str(v) for v in data]
    else:
        print("Unexpected JSON shape from pnpm output.", file=sys.stderr)
        return []
    # pnpm lists oldest-first; reverse to newest-first like `pip index versions`.
    return list(reversed(versions))


def setup_venv(env_dir, pnpm_version=DEFAULT_PNPM_VERSION, cfg=None, verbose=False):
    """Create a fresh temp project dir if needed; return its directory path.

    The sandbox's pnpm is pinned to ``pnpm_version`` (default
    ``DEFAULT_PNPM_VERSION``) so install-tests run against a known pnpm. Pass
    ``pnpm_version=None`` to keep whatever pnpm is on PATH. ``verbose`` echoes
    the pnpm-pin output so a failed pin can be debugged.
    """
    cfg = cfg or resolve_env()
    if not os.path.exists(env_dir):
        print(f"Creating temp project at: {env_dir}")
        os.makedirs(env_dir, exist_ok=True)
    # A minimal package.json keeps pnpm from walking up to a parent workspace.
    pkg_json = os.path.join(env_dir, "package.json")
    if not os.path.exists(pkg_json):
        with open(pkg_json, "w") as f:
            json.dump({"name": "pnpm-versions-sandbox", "private": True}, f)

    if pnpm_version:
        _ensure_pnpm_version(env_dir, pnpm_version, cfg, verbose=verbose)
    return env_dir


def _ensure_pnpm_version(env_dir, pnpm_version, cfg=None, verbose=False):
    """Pin the sandbox to ``pnpm_version`` by writing packageManager in package.json.

    pnpm (via corepack) honours the ``packageManager`` field, so pinning here
    keeps the temp project's install-tests on a known pnpm without touching the
    global toolchain.
    """
    cfg = cfg or resolve_env()
    print(f"Ensuring pnpm=={pnpm_version} in the test environment...")
    pkg_json = os.path.join(env_dir, "package.json")
    try:
        with open(pkg_json) as f:
            data = json.load(f)
        data["packageManager"] = f"pnpm@{pnpm_version}"
        with open(pkg_json, "w") as f:
            json.dump(data, f)
        if verbose:
            _echo(f"set packageManager = pnpm@{pnpm_version} in {pkg_json}")
    except (OSError, ValueError) as e:
        print(
            f"Warning: could not pin pnpm=={pnpm_version}: {e}",
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
    """True if pnpm ``options`` already carry a verbose loglevel flag."""
    for i, o in enumerate(options):
        if o == "--loglevel" and i + 1 < len(options) and options[i + 1] in (
            "verbose", "silly", "info", "debug",
        ):
            return True
    return False


# pnpm loglevels that flood stdout/stderr — these are the ones worth stripping
# from a discovery query whose output we parse as a tiny JSON blob.
_VERBOSE_LOGLEVELS = ("verbose", "silly", "info", "http", "debug")


def _strip_verbose(options):
    """Return ``options`` with any verbose ``--loglevel <level>`` pair removed.

    ``pnpm_options`` emits ``--loglevel <NPM_CONFIG_LOGLEVEL>``; if that level
    is a chatty one (verbose/silly/debug/...) it can flood the captured buffer
    (and overflow the Node twin's spawnSync limit) on the discovery query. Drop
    the flag+value pair for that case; quiet levels (warn/error) are untouched.
    """
    out = []
    i = 0
    while i < len(options):
        if options[i] == "--loglevel" and i + 1 < len(options) and \
                options[i + 1] in _VERBOSE_LOGLEVELS:
            i += 2  # skip the flag and its value
            continue
        out.append(options[i])
        i += 1
    return out


def _stream(cmd, env, cwd=None):
    """Run ``cmd``, echoing combined output live while capturing it.

    Returns ``(returncode, combined_output)``. Used in verbose mode so the user
    watches pnpm in real time (e.g. a slow build or a hang) yet the captured
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


def test_installations(pip_path, package, index_url, versions, output_json,
                       first_only=False, cfg=None, verbose=False):
    """Attempt to add each version; write an incremental JSON report.

    ``pip_path`` is the temp project directory returned by ``setup_venv``.
    Returns the list of result dicts. If ``first_only`` is set, stops after
    the first version that installs successfully. When ``verbose`` is set,
    pnpm's full output is streamed live (and a ``--loglevel debug`` flag is added
    if none is present) so install failures can be debugged; the captured output
    is also folded into the report under ``log``/``error``.
    """
    cfg = cfg or resolve_env()
    env = subprocess_env(cfg)
    options = pnpm_options(cfg)
    results = []
    installable = []

    for idx, version in enumerate(versions, start=1):
        target = f"{package}@{version}"
        print(f"[{idx}/{len(versions)}] Attempting to install: {target}...")

        cmd = [
            "pnpm",
            "add",
            target,
            "--dir",
            pip_path,
            "--save-prod",
            "--ignore-scripts",
        ]
        cmd += options
        if index_url:
            cmd += ["--registry", index_url]
        # Bump pnpm's own verbosity if the user wants detail and nothing already set it.
        if verbose and not _has_verbose(options):
            cmd += ["--loglevel", "debug"]

        if verbose:
            print(f"  $ {' '.join(cmd)}")
            returncode, output = _stream(cmd, env, cwd=pip_path)
            stdout_text = stderr_text = output  # streamed combined; same text both ways
        else:
            res = subprocess.run(
                cmd, capture_output=True, text=True, env=env, cwd=pip_path,
            )
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
        description="Find installable versions of a package from a registry via pnpm.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("package", help="Package name to probe (e.g. left-pad).")
    p.add_argument(
        "--registry",
        "--index-url",
        dest="index_url",
        default=None,
        help="Custom npm registry URL. Defaults to $NPM_CONFIG_REGISTRY, "
             "then $NODE_REGISTRY_URL, then https://registry.npmjs.org.",
    )
    p.add_argument(
        "--venv-dir",
        default=".pnpm-test-install",
        help="Directory for the isolated test temp project.",
    )
    p.add_argument(
        "--pnpm-version",
        default=DEFAULT_PNPM_VERSION,
        help="pnpm version to pin in the test project ('none' to keep the pnpm on PATH).",
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
        help="Stream full pnpm output for every step so failures are debuggable.",
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
          f"(registry: {cfg['NODE_REGISTRY_NAME']}).")
    pnpm_version = None if str(args.pnpm_version).lower() == "none" else args.pnpm_version
    pip_path = setup_venv(args.venv_dir, pnpm_version, cfg, verbose=args.verbose)
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
# Example — probe the newest 5 versions of left-pad, stop at the first installable:
#     main(["left-pad", "--registry", "https://reg.example.com",
#           "--limit", "5", "--first-only"])
#
# Equivalent on the command line:
#     python3 main.py left-pad \
#         --registry https://reg.example.com --limit 5 --first-only

if __name__ == "__main__":
    raise SystemExit(main())  # argv=None -> parse_args reads sys.argv
