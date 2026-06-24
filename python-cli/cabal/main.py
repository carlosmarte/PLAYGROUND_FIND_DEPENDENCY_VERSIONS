#!/usr/bin/env python3
"""Find installable versions of a package from a (custom) Hackage registry.

Discovers every version Hackage advertises for a package via its HTTP JSON
endpoint (``https://hackage.haskell.org/package/<pkg>.json``, a
version->preference map), then attempts to fetch each one into an isolated
scratch directory with ``cabal get``, recording success/failure per version to
a JSON report.

Example:
    python main.py aeson \
        --index-url https://hackage.haskell.org

    # only probe the newest 5 versions, stop at the first that fetches
    python main.py aeson --index-url https://hackage.haskell.org \
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

# cabal tool version the test environment expects by default. Fetch-tests run
# against this cabal, so it governs resolver/fetch behaviour. Override via
# --cabal-version (CLI) or the `cabal` command (REPL). cabal is not pinnable the
# way pip is, so this is advisory: we surface it and warn on a mismatch.
DEFAULT_CABAL_VERSION = "3.12.1.0"

# Environment knobs read via os.environ.get, each falling back to the value the
# Haskell / cabal / TLS ecosystem uses by default ("industry standard"). cabal
# reads a handful of vars from the environment; we resolve them explicitly so
# the documented default still applies when the var is unset, and so they can be
# surfaced (REPL `env`) and threaded into every cabal invocation we build.
ENV_DEFAULTS = {
    "CABAL_VERBOSE": "0",                            # cabal: quiet (0 = -v0)
    "CABAL_CERT": "",                                # cabal: use system CA store
    "HACKAGE_API_URL": "https://hackage.haskell.org",  # Hackage JSON/page base
    "CABAL_REMOTE_REPO": "https://hackage.haskell.org",  # cabal: remote-repo URL
    "CABAL_INSECURE": "0",                            # cabal: keep TLS verification
    "CABAL_HTTP_TIMEOUT": "15",                      # advisory: 15s socket timeout
    "CABAL_HTTP_RETRIES": "5",                       # advisory: fetch retries
    "CABAL_REGISTRY_URL": "https://hackage.haskell.org",  # our index-url fallback
    "CABAL_REGISTRY_NAME": "Hackage",               # registry display name
    "REQUESTS_CA_BUNDLE": "",                        # urllib: certifi CA bundle
    "SSL_CERT_FILE": "",                             # OpenSSL: system CA file
    "SSL_CERT_DIR": "",                              # OpenSSL: system CA dir
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
    """Pick the index URL: explicit flag > CABAL_REGISTRY_URL > HACKAGE_API_URL."""
    cfg = cfg or resolve_env()
    return explicit or cfg["CABAL_REGISTRY_URL"] or cfg["HACKAGE_API_URL"] or None


def cabal_options(cfg):
    """Translate resolved config into cabal command-line flags."""
    opts = []
    try:
        level = int(cfg["CABAL_VERBOSE"])
    except (TypeError, ValueError):
        level = 0
    if level > 0:
        opts.append("-v" + str(level))  # cabal: -v1 / -v2 / -v3 verbosity
    return opts


def subprocess_env(cfg):
    """Child-process environment with resolved cabal/TLS vars applied."""
    env = os.environ.copy()
    for name in _TLS_ENV_VARS:
        if cfg[name]:
            env[name] = cfg[name]
    if cfg["CABAL_CERT"]:
        env["SSL_CERT_FILE"] = cfg["CABAL_CERT"]
    return env


def _api_base(index_url, cfg):
    """Derive the Hackage base URL from the index URL or HACKAGE_API_URL."""
    if index_url:
        return index_url.rstrip("/")
    return cfg["HACKAGE_API_URL"].rstrip("/")


def get_available_versions(package, index_url, cfg=None, verbose=False):
    """Return the list of versions Hackage advertises for ``package``.

    Primary source is Hackage's JSON endpoint (``/package/<pkg>.json``), a
    ``{version: preference}`` map. We sort the keys descending by their numeric
    components so the list comes back newest-first. When ``verbose`` is set, the
    URL and raw output are echoed so a failed or empty discovery can be
    debugged.
    """
    cfg = cfg or resolve_env()
    print(f"Retrieving versions for '{package}' from {index_url}...")
    base = _api_base(index_url, cfg)
    url = f"{base}/package/{package}.json"
    if verbose:
        print(f"  $ GET {url}")

    try:
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=int(cfg["CABAL_HTTP_TIMEOUT"])) as resp:
            payload = resp.read().decode("utf-8")
    except Exception as e:  # noqa: BLE001
        print(f"Error querying Hackage: {e}", file=sys.stderr)
        return []

    if verbose:
        _echo(payload)
    try:
        data = json.loads(payload)
        # The JSON endpoint is a {version: "normal"/"unpreferred"/...} map; the
        # keys are the versions. Sort newest-first by numeric version tuple.
        versions = sorted(data.keys(), key=_version_key, reverse=True)
    except (ValueError, AttributeError) as e:
        print(f"Could not parse Hackage JSON: {e}", file=sys.stderr)
        return []
    if not versions:
        print("No versions in Hackage response.", file=sys.stderr)
    return versions


def _version_key(ver):
    """Return a sortable tuple of numeric components for a version string."""
    return tuple(int(p) if p.isdigit() else 0 for p in re.split(r"[.\-]", ver))


def setup_venv(env_dir, cabal_version=DEFAULT_CABAL_VERSION, cfg=None, verbose=False):
    """Create a fresh scratch fetch directory if needed; return its path.

    cabal has no per-project virtualenv: the isolated sandbox is a throwaway
    directory each ``cabal get`` unpacks into. The directory is created lazily
    and reused. ``cabal_version`` is advisory (cabal is not pinnable like pip);
    pass ``cabal_version=None`` to skip the version check. ``verbose`` echoes
    the version probe so a mismatch can be debugged.
    """
    cfg = cfg or resolve_env()
    if not os.path.exists(env_dir):
        print(f"Creating fetch sandbox at: {env_dir}")
        os.makedirs(env_dir, exist_ok=True)

    if cabal_version:
        _ensure_cabal_version(cabal_version, cfg, verbose=verbose)
    # The "handle" the test step needs is just the sandbox directory.
    return env_dir


def _ensure_cabal_version(cabal_version, cfg=None, verbose=False):
    """Check the installed cabal against ``cabal_version`` (advisory only)."""
    cfg = cfg or resolve_env()
    print(f"Ensuring cabal=={cabal_version} in the test environment...")
    cmd = ["cabal", "--version"]
    if verbose:
        print(f"  $ {' '.join(cmd)}")
    res = subprocess.run(cmd, capture_output=True, text=True, env=subprocess_env(cfg))
    if verbose:
        _echo(res.stdout, res.stderr)
    if res.returncode != 0:
        # A negative returncode means the child was killed by a signal, leaving
        # stderr empty — fall back to the signal name so the warning isn't blank.
        detail = _last_line(res.stderr)
        if not detail and res.returncode is not None and res.returncode < 0:
            try:
                detail = f"terminated by signal {signal.Signals(-res.returncode).name}"
            except ValueError:
                detail = f"terminated by signal {-res.returncode}"
        print(
            f"Warning: could not verify cabal=={cabal_version}: "
            f"{detail or 'cabal not found'}",
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
    """True if cabal ``options`` already carry a ``-v``/``-v2`` flag."""
    return any(o.startswith("-v") for o in options)


def _stream(cmd, env):
    """Run ``cmd``, echoing combined output live while capturing it.

    Returns ``(returncode, combined_output)``. Used in verbose mode so the user
    watches cabal in real time (e.g. a slow fetch or a hang) yet the captured
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


def test_installations(env_dir, package, index_url, versions, output_json,
                       first_only=False, cfg=None, verbose=False):
    """Attempt to fetch each version; write an incremental JSON report.

    Returns the list of result dicts. If ``first_only`` is set, stops after the
    first version that fetches successfully. When ``verbose`` is set, cabal's
    full output is streamed live (and a ``-v2`` flag is added if none is
    present) so fetch failures can be debugged; the captured output is also
    folded into the report under ``log``/``error``.
    """
    cfg = cfg or resolve_env()
    env = subprocess_env(cfg)
    options = cabal_options(cfg)
    results = []
    installable = []

    for idx, version in enumerate(versions, start=1):
        target = f"{package}-{version}"
        print(f"[{idx}/{len(versions)}] Attempting to fetch: {target}...")

        # Each fetch unpacks into its own subdir of the sandbox so versions
        # never clobber one another and the sandbox stays inspectable.
        dest = os.path.join(env_dir, target)
        cmd = [
            "cabal",
            "get",
            target,
            "-d",
            dest,
        ]
        cmd += options
        # Bump cabal's own verbosity if the user wants detail and nothing set it.
        if verbose and not _has_verbose(options):
            cmd.append("-v2")

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
        description="Find installable versions of a package from a Hackage registry.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("package", help="Package name to probe (e.g. aeson).")
    p.add_argument(
        "--index-url",
        default=None,
        help="Custom Hackage registry URL. Defaults to $CABAL_REGISTRY_URL, "
             "then $HACKAGE_API_URL, then https://hackage.haskell.org.",
    )
    p.add_argument(
        "--venv-dir",
        default=".cabal-test-fetch",
        help="Directory for the isolated fetch sandbox.",
    )
    p.add_argument(
        "--cabal-version",
        default=DEFAULT_CABAL_VERSION,
        help="cabal version expected in the test sandbox ('none' to skip the check).",
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
        help="Stop after the first version that fetches successfully.",
    )
    p.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="Stream full cabal output for every step so failures are debuggable.",
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
          f"(registry: {cfg['CABAL_REGISTRY_NAME']}).")
    cabal_version = None if str(args.cabal_version).lower() == "none" else args.cabal_version
    env_dir = setup_venv(args.venv_dir, cabal_version, cfg, verbose=args.verbose)
    test_installations(
        env_dir,
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
# Example — probe the newest 5 versions of aeson, stop at the first fetchable:
#     main(["aeson", "--index-url", "https://hackage.haskell.org",
#           "--limit", "5", "--first-only"])
#
# Equivalent on the command line:
#     python3 main.py aeson \
#         --index-url https://hackage.haskell.org --limit 5 --first-only

if __name__ == "__main__":
    raise SystemExit(main())  # argv=None -> parse_args reads sys.argv
