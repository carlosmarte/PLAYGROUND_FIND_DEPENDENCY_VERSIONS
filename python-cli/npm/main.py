#!/usr/bin/env python3
"""Find installable versions of a package from a (custom) npm registry.

Discovers every version a registry advertises for a package via
``npm view <pkg> versions --json``, then attempts to install each one in an
isolated install prefix, recording success/failure per version to a JSON report.

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

# npm version the test environment is pinned to by default. Install-tests run
# against this npm, so it governs resolver/lockfile behaviour. Override via
# --npm-version (CLI) or the `npm` command (REPL).
DEFAULT_NPM_VERSION = "10.9.2"

# Environment knobs read via os.environ.get, each falling back to the value the
# Node.js / npm / TLS ecosystem uses by default ("industry standard"). npm
# itself auto-reads NPM_CONFIG_* vars from the environment; we resolve them
# explicitly so the documented default still applies when the var is unset, and
# so they can be surfaced (REPL `env`) and threaded into every npm invocation.
ENV_DEFAULTS = {
    "NPM_CONFIG_LOGLEVEL": "warn",                   # npm: log level (warn = quiet)
    "NPM_CONFIG_CAFILE": "",                          # npm: use bundled/system CA store
    "NPM_CONFIG_REGISTRY": "https://registry.npmjs.org",  # npm: package registry
    "NPM_CONFIG_STRICT_SSL": "true",                  # npm: verify TLS certificates
    "NPM_CONFIG_FETCH_TIMEOUT": "300000",             # npm: 300s fetch timeout (ms)
    "NPM_CONFIG_FETCH_RETRIES": "2",                  # npm: 2 fetch retries
    "NODE_REGISTRY_URL": "https://registry.npmjs.org",  # our registry fallback
    "NODE_REGISTRY_NAME": "npm",                      # registry display name
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


def npm_options(cfg):
    """Translate resolved config into npm command-line flags."""
    opts = []
    level = (cfg["NPM_CONFIG_LOGLEVEL"] or "").strip()
    if level:
        opts += ["--loglevel", level]
    if cfg["NPM_CONFIG_CAFILE"]:
        opts += ["--cafile", cfg["NPM_CONFIG_CAFILE"]]
    if str(cfg["NPM_CONFIG_STRICT_SSL"]).lower() in ("false", "0", "no"):
        opts += ["--strict-ssl", "false"]
    opts += ["--fetch-timeout", str(cfg["NPM_CONFIG_FETCH_TIMEOUT"])]
    opts += ["--fetch-retries", str(cfg["NPM_CONFIG_FETCH_RETRIES"])]
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
    ``npm view <pkg> versions --json`` (npm returns them oldest-first, so we
    reverse). When ``verbose`` is set, the npm command and its raw output are
    echoed so a failed or empty discovery can be debugged.
    """
    cfg = cfg or resolve_env()
    print(f"Retrieving versions for '{package}' from {index_url}...")
    cmd = [
        "npm",
        "view",
        package,
        "versions",
        "--json",
    ]
    # Strip any verbose `--loglevel` for this query: we only parse a tiny JSON
    # blob, but a chatty loglevel (verbose/silly/debug) emits a flood of output
    # — a flood that bloats the captured buffer (and overflows the Node twin's
    # spawnSync limit). Keep the discovery query quiet.
    cmd += _strip_verbose(npm_options(cfg))
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
        print(f"Error running 'npm view': {detail or 'unknown error'}", file=sys.stderr)
        sys.exit(1)

    if verbose:
        _echo(result.stdout)
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError:
        print("Could not parse JSON from npm output.", file=sys.stderr)
        return []
    # npm yields a JSON string for a single version, or a JSON array for many.
    if isinstance(data, str):
        versions = [data]
    elif isinstance(data, list):
        versions = [str(v) for v in data]
    else:
        print("Unexpected JSON shape from npm output.", file=sys.stderr)
        return []
    # npm lists oldest-first; reverse to newest-first like `pip index versions`.
    return list(reversed(versions))


def setup_venv(env_dir, npm_version=DEFAULT_NPM_VERSION, cfg=None, verbose=False, index_url=None):
    """Create a fresh install prefix if needed; return its directory path.

    The prefix's npm is pinned to ``npm_version`` (default
    ``DEFAULT_NPM_VERSION``) so install-tests run against a known npm. Pass
    ``npm_version=None`` to keep whatever npm is on PATH. ``verbose`` echoes the
    npm-pin output so a failed pin can be debugged. ``index_url`` is the resolved
    registry the pin is fetched from, so the pinned npm comes from the SAME
    registry the version probe and install-tests use (pass ``None`` for npm's
    default).
    """
    cfg = cfg or resolve_env()
    if not os.path.exists(env_dir):
        print(f"Creating install prefix at: {env_dir}")
        os.makedirs(env_dir, exist_ok=True)
    # A minimal package.json keeps npm from walking up to a parent project.
    pkg_json = os.path.join(env_dir, "package.json")
    if not os.path.exists(pkg_json):
        with open(pkg_json, "w") as f:
            json.dump({"name": "npm-versions-sandbox", "private": True}, f)

    if npm_version:
        _ensure_npm_version(env_dir, npm_version, cfg, verbose=verbose, index_url=index_url)
    return env_dir


def _ensure_npm_version(env_dir, npm_version, cfg=None, verbose=False, index_url=None):
    """Pin the sandbox's local npm to ``npm_version`` (fetched from the resolved registry)."""
    cfg = cfg or resolve_env()
    print(f"Ensuring npm=={npm_version} in the test environment...")
    cmd = (
        ["npm", "install", "--prefix", env_dir, "--no-save", f"npm@{npm_version}"]
        + npm_options(cfg)
    )
    # Fetch the pinned npm from the same registry as discovery / install-tests,
    # not whatever ambient default npm would otherwise use.
    if index_url:
        cmd += ["--registry", index_url]
    if verbose:
        print(f"  $ {' '.join(cmd)}")
    res = subprocess.run(cmd, capture_output=True, text=True, env=subprocess_env(cfg))
    if verbose:
        _echo(res.stdout, res.stderr)
    if res.returncode != 0:
        print(
            f"Warning: could not pin npm=={npm_version}: "
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
    """True if npm ``options`` already carry a verbose loglevel flag."""
    for i, o in enumerate(options):
        if o in ("-d", "-dd", "--verbose"):
            return True
        if o == "--loglevel" and i + 1 < len(options) and options[i + 1] in (
            "verbose", "silly", "info",
        ):
            return True
    return False


# npm loglevels that flood stdout/stderr — these are the ones worth stripping
# from a discovery query whose output we parse as a tiny JSON blob.
_VERBOSE_LOGLEVELS = ("verbose", "silly", "info", "http", "debug")


def _strip_verbose(options):
    """Return ``options`` with any verbose ``--loglevel <level>`` pair removed.

    ``npm_options`` emits ``--loglevel <NPM_CONFIG_LOGLEVEL>``; if that level is
    a chatty one (verbose/silly/debug/...) it can flood the captured buffer (and
    overflow the Node twin's spawnSync limit) on the discovery query. Drop the
    flag+value pair for that case; quiet levels (warn/error) are left untouched.
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


def _stream(cmd, env):
    """Run ``cmd``, echoing combined output live while capturing it.

    Returns ``(returncode, combined_output)``. Used in verbose mode so the user
    watches npm in real time (e.g. a slow build or a hang) yet the captured text
    still feeds the JSON report.
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


def test_installations(pip_path, package, index_url, versions, output_json,
                       first_only=False, cfg=None, verbose=False):
    """Attempt to install each version; write an incremental JSON report.

    ``pip_path`` is the install-prefix directory returned by ``setup_venv``.
    Returns the list of result dicts. If ``first_only`` is set, stops after
    the first version that installs successfully. When ``verbose`` is set, npm's
    full output is streamed live (and a ``--loglevel verbose`` flag is added if
    none is present) so install failures can be debugged; the captured output is
    also folded into the report under ``log``/``error``.
    """
    cfg = cfg or resolve_env()
    env = subprocess_env(cfg)
    options = npm_options(cfg)
    results = []
    installable = []

    for idx, version in enumerate(versions, start=1):
        target = f"{package}@{version}"
        print(f"[{idx}/{len(versions)}] Attempting to install: {target}...")

        cmd = [
            "npm",
            "install",
            target,
            "--prefix",
            pip_path,
            "--no-save",
            "--no-audit",
            "--no-fund",
        ]
        cmd += options
        if index_url:
            cmd += ["--registry", index_url]
        # Bump npm's own verbosity if the user wants detail and nothing already set it.
        if verbose and not _has_verbose(options):
            cmd += ["--loglevel", "verbose"]

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
        description="Find installable versions of a package from an npm registry.",
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
        default=".npm-test-install",
        help="Directory for the isolated test install prefix.",
    )
    p.add_argument(
        "--npm-version",
        default=DEFAULT_NPM_VERSION,
        help="npm version to pin in the test prefix ('none' to keep the npm on PATH).",
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
        help="Stream full npm output for every step so failures are debuggable.",
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
    npm_version = None if str(args.npm_version).lower() == "none" else args.npm_version
    pip_path = setup_venv(args.venv_dir, npm_version, cfg, verbose=args.verbose, index_url=index_url)
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
