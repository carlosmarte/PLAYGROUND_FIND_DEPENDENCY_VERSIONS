#!/usr/bin/env python3
"""Find installable versions of a package from the JSR registry.

Discovers every version JSR advertises for a ``@scope/name`` package via the
registry's HTTP JSON metadata (``https://jsr.io/@<scope>/<name>/meta.json``),
then attempts to add each one into an isolated temp project with
``npx jsr add``, recording success/failure per version to a JSON report.

Example:
    python main.py @std/encoding \
        --registry https://jsr.io

    # only probe the newest 5 versions, stop at the first that installs
    python main.py @std/encoding --registry https://jsr.io \
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

# jsr/deno toolchain version the test environment is pinned to by default.
# Install-tests run via `npx jsr add`, which doesn't take a pinned jsr version
# the way pip pins pip, so this is informational ("none" keeps whatever is on
# PATH). Override via --jsr-version (CLI) or the `jsr` command (REPL).
DEFAULT_JSR_VERSION = "none"

# Environment knobs read via os.environ.get, each falling back to the value the
# JSR / Node.js / TLS ecosystem uses by default ("industry standard"). The JSR
# registry is HTTP-only for discovery; `npx jsr add` reads NPM_CONFIG_* like
# npm. We resolve them explicitly so the documented default still applies when
# the var is unset, surface them (REPL `env`), and thread them into invocations.
ENV_DEFAULTS = {
    "NPM_CONFIG_LOGLEVEL": "warn",                   # npx/jsr: log level (warn = quiet)
    "NPM_CONFIG_CAFILE": "",                          # npx: use bundled/system CA store
    "JSR_URL": "https://jsr.io",                      # jsr: registry base URL
    "NPM_CONFIG_STRICT_SSL": "true",                  # npx: verify TLS certificates
    "JSR_FETCH_TIMEOUT": "30",                        # our HTTP discovery timeout (s)
    "JSR_FETCH_RETRIES": "2",                         # our HTTP discovery retries
    "JSR_REGISTRY_URL": "https://jsr.io",             # our registry fallback
    "JSR_REGISTRY_NAME": "JSR",                       # registry display name
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
    """Pick the registry URL: explicit flag > JSR_URL > JSR_REGISTRY_URL."""
    cfg = cfg or resolve_env()
    return explicit or cfg["JSR_URL"] or cfg["JSR_REGISTRY_URL"] or None


def jsr_options(cfg):
    """Translate resolved config into `npx jsr add` command-line flags."""
    opts = []
    level = (cfg["NPM_CONFIG_LOGLEVEL"] or "").strip()
    if level:
        opts += ["--loglevel", level]
    if cfg["NPM_CONFIG_CAFILE"]:
        opts += ["--cafile", cfg["NPM_CONFIG_CAFILE"]]
    if str(cfg["NPM_CONFIG_STRICT_SSL"]).lower() in ("false", "0", "no"):
        opts += ["--strict-ssl", "false"]
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


def _split_scope_name(package):
    """Split a ``@scope/name`` package into ``(scope, name)`` for URL building.

    JSR packages are always scoped. A leading ``@`` is optional in user input;
    we normalise it away for the URL path.
    """
    pkg = package.lstrip("@")
    if "/" not in pkg:
        raise ValueError(f"JSR package must be '@scope/name', got {package!r}")
    scope, name = pkg.split("/", 1)
    return scope, name


def get_available_versions(package, index_url, cfg=None, verbose=False):
    """Return the list of versions JSR advertises for ``package``.

    JSR has no "list versions" CLI; instead we GET the registry's JSON metadata
    at ``<registry>/@<scope>/<name>/meta.json`` (stdlib ``urllib.request``) and
    read the keys of its ``versions`` object. Versions are returned
    newest-first (sorted descending). When ``verbose`` is set, the request URL
    and raw payload are echoed so a failed or empty discovery can be debugged.
    """
    cfg = cfg or resolve_env()
    base = (index_url or cfg["JSR_REGISTRY_URL"]).rstrip("/")
    try:
        scope, name = _split_scope_name(package)
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
    meta_url = f"{base}/@{scope}/{name}/meta.json"
    print(f"Retrieving versions for '{package}' from {base}...")
    if verbose:
        print(f"  $ GET {meta_url}")

    payload = _http_get_json(meta_url, cfg, verbose=verbose)
    if payload is None:
        sys.exit(1)
    if verbose:
        _echo(json.dumps(payload))
    versions_map = payload.get("versions")
    if not isinstance(versions_map, dict):
        print("Could not find a 'versions' object in JSR meta.json.", file=sys.stderr)
        return []
    # Drop yanked versions, then sort newest-first by semver-ish version key.
    live = [v for v, meta in versions_map.items()
            if not (isinstance(meta, dict) and meta.get("yanked"))]
    return sorted(live, key=_version_key, reverse=True)


def _version_key(version):
    """Sort key turning a version string into a comparable tuple (newest-first).

    Numeric dotted segments compare numerically; a trailing pre-release suffix
    (after ``-``) is kept as text so ``1.2.0`` sorts above ``1.2.0-rc.1``.
    """
    core, _, pre = version.partition("-")
    nums = tuple(int(p) if p.isdigit() else 0 for p in core.split("."))
    # A release (no pre) ranks above any pre-release of the same core.
    return (nums, pre == "", pre)


def _http_get_json(url, cfg=None, verbose=False):
    """GET ``url`` and parse JSON, retrying per JSR_FETCH_RETRIES. Returns dict or None."""
    cfg = cfg or resolve_env()
    try:
        timeout = float(cfg["JSR_FETCH_TIMEOUT"])
    except (TypeError, ValueError):
        timeout = 30.0
    try:
        retries = int(cfg["JSR_FETCH_RETRIES"])
    except (TypeError, ValueError):
        retries = 2
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    last_err = ""
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, ValueError) as e:
            last_err = str(getattr(e, "reason", e) or e)
            if verbose:
                _echo(f"  attempt {attempt + 1} failed: {last_err}")
    print(f"Error fetching {url}: {last_err or 'unknown error'}", file=sys.stderr)
    return None


def setup_venv(env_dir, jsr_version=DEFAULT_JSR_VERSION, cfg=None, verbose=False):
    """Create a fresh temp project dir if needed; return its directory path.

    JSR installs land in a Node-style project via ``npx jsr add``. We pin the
    tool concept to ``jsr_version`` (default ``DEFAULT_JSR_VERSION`` = "none"),
    which is informational here: JSR's CLI isn't versioned the way pip is, so
    "none" keeps whatever jsr/deno is on PATH. ``verbose`` echoes the setup.
    """
    cfg = cfg or resolve_env()
    if not os.path.exists(env_dir):
        print(f"Creating temp project at: {env_dir}")
        os.makedirs(env_dir, exist_ok=True)
    # A minimal package.json keeps npx/jsr from walking up to a parent project.
    pkg_json = os.path.join(env_dir, "package.json")
    if not os.path.exists(pkg_json):
        with open(pkg_json, "w") as f:
            json.dump({"name": "jsr-versions-sandbox", "private": True}, f)

    if jsr_version and str(jsr_version).lower() != "none":
        _ensure_jsr_version(env_dir, jsr_version, cfg, verbose=verbose)
    return env_dir


def _ensure_jsr_version(env_dir, jsr_version, cfg=None, verbose=False):
    """Record the requested jsr/deno toolchain version for the sandbox.

    JSR's ``npx jsr`` CLI isn't pinned the way pip pins pip, so this is a
    best-effort note rather than a hard install. We stash it under
    ``packageManager`` so the intent is visible in the temp project.
    """
    cfg = cfg or resolve_env()
    print(f"Ensuring jsr=={jsr_version} in the test environment...")
    pkg_json = os.path.join(env_dir, "package.json")
    try:
        with open(pkg_json) as f:
            data = json.load(f)
        data["jsrVersion"] = str(jsr_version)
        with open(pkg_json, "w") as f:
            json.dump(data, f)
        if verbose:
            _echo(f"recorded jsrVersion = {jsr_version} in {pkg_json}")
    except (OSError, ValueError) as e:
        print(
            f"Warning: could not pin jsr=={jsr_version}: {e}",
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
    """True if `npx jsr` ``options`` already carry a verbose loglevel flag."""
    for i, o in enumerate(options):
        if o == "--loglevel" and i + 1 < len(options) and options[i + 1] in (
            "verbose", "silly", "info", "debug",
        ):
            return True
    return False


def _stream(cmd, env, cwd=None):
    """Run ``cmd``, echoing combined output live while capturing it.

    Returns ``(returncode, combined_output)``. Used in verbose mode so the user
    watches `npx jsr` in real time (e.g. a slow build or a hang) yet the
    captured text still feeds the JSON report.
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
    """Attempt to add each version via `npx jsr add`; write an incremental report.

    ``pip_path`` is the temp project directory returned by ``setup_venv``.
    Returns the list of result dicts. If ``first_only`` is set, stops after
    the first version that installs successfully. When ``verbose`` is set,
    `npx jsr`'s full output is streamed live (and a ``--loglevel verbose`` flag
    is added if none is present) so install failures can be debugged; the
    captured output is also folded into the report under ``log``/``error``.
    """
    cfg = cfg or resolve_env()
    env = subprocess_env(cfg)
    # JSR_URL points npx/jsr at a custom registry mirror when set.
    if index_url:
        env["JSR_URL"] = index_url
    options = jsr_options(cfg)
    results = []
    installable = []
    scope, name = _split_scope_name(package)

    for idx, version in enumerate(versions, start=1):
        target = f"@{scope}/{name}@{version}"
        print(f"[{idx}/{len(versions)}] Attempting to install: {target}...")

        cmd = [
            "npx",
            "jsr",
            "add",
            target,
        ]
        cmd += options
        # Bump verbosity if the user wants detail and nothing already set it.
        if verbose and not _has_verbose(options):
            cmd += ["--loglevel", "verbose"]

        if verbose:
            print(f"  $ {' '.join(cmd)}")
            returncode, output = _stream(cmd, env, cwd=pip_path)
            stdout_text = stderr_text = output  # streamed combined; same text both ways
        else:
            res = subprocess.run(
                cmd, capture_output=True, text=True, env=env, cwd=pip_path,
            )
            returncode, stdout_text, stderr_text = res.returncode, res.stdout, res.stderr
            # A negative returncode means the child was killed by a signal, leaving
            # stderr empty — fall back to the signal name so it isn't blank.
            if not (stderr_text or "").strip() and returncode is not None and returncode < 0:
                try:
                    stderr_text = f"terminated by signal {signal.Signals(-returncode).name}"
                except ValueError:
                    stderr_text = f"terminated by signal {-returncode}"

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
        description="Find installable versions of a package from the JSR registry.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("package", help="Scoped package to probe (e.g. @std/encoding).")
    p.add_argument(
        "--registry",
        "--index-url",
        dest="index_url",
        default=None,
        help="Custom JSR registry URL. Defaults to $JSR_URL, "
             "then $JSR_REGISTRY_URL, then https://jsr.io.",
    )
    p.add_argument(
        "--venv-dir",
        default=".jsr-test-install",
        help="Directory for the isolated test temp project.",
    )
    p.add_argument(
        "--jsr-version",
        default=DEFAULT_JSR_VERSION,
        help="jsr/deno toolchain version to record for the test project ('none' to keep PATH).",
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
        help="Stream full npx jsr output for every step so failures are debuggable.",
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
          f"(registry: {cfg['JSR_REGISTRY_NAME']}).")
    jsr_version = None if str(args.jsr_version).lower() == "none" else args.jsr_version
    pip_path = setup_venv(args.venv_dir, jsr_version, cfg, verbose=args.verbose)
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
# Example — probe the newest 5 versions of @std/encoding, stop at the first installable:
#     main(["@std/encoding", "--registry", "https://jsr.io",
#           "--limit", "5", "--first-only"])
#
# Equivalent on the command line:
#     python3 main.py @std/encoding \
#         --registry https://jsr.io --limit 5 --first-only

if __name__ == "__main__":
    raise SystemExit(main())  # argv=None -> parse_args reads sys.argv
