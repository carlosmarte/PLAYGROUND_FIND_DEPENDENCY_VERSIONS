#!/usr/bin/env python3
"""Find installable versions of a package from a (custom) Hex registry.

Discovers every version the Hex.pm registry advertises for a package via its
HTTP JSON API (``https://hex.pm/api/packages/<pkg>``, ``releases[].version``),
then attempts to fetch each one into an isolated scratch directory with
``mix hex.package fetch``, recording success/failure per version to a JSON
report.

Example:
    python main.py jason \
        --index-url https://hex.pm

    # only probe the newest 5 versions, stop at the first that fetches
    python main.py jason --index-url https://hex.pm \
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

# Hex/mix tool version the test environment expects by default. Fetch-tests run
# against this mix+hex, so it governs resolver/fetch behaviour. Override via
# --hex-version (CLI) or the `hex` command (REPL). Hex is not pinnable the way
# pip is, so this is advisory: we surface it and warn on a mismatch.
DEFAULT_HEX_VERSION = "2.1.1"

# Environment knobs read via os.environ.get, each falling back to the value the
# Elixir / Hex / TLS ecosystem uses by default ("industry standard"). mix/hex
# auto-read HEX_* vars from the environment; we resolve them explicitly so the
# documented default still applies when the var is unset, and so they can be
# surfaced (REPL `env`) and threaded into every mix invocation we build.
ENV_DEFAULTS = {
    "HEX_VERBOSE": "0",                              # hex: quiet (0 = no debug)
    "HEX_CACERTS_PATH": "",                          # hex: use system CA store
    "HEX_API_URL": "https://hex.pm/api",             # hex: JSON API base
    "HEX_MIRROR": "https://repo.hex.pm",             # hex: package repo mirror
    "HEX_UNSAFE_HTTPS": "0",                          # hex: keep TLS verification
    "HEX_HTTP_TIMEOUT": "15",                        # hex: 15s socket timeout
    "HEX_HTTP_CONCURRENCY": "8",                     # hex: parallel fetches
    "HEX_REGISTRY_URL": "https://hex.pm",            # our index-url fallback
    "HEX_REGISTRY_NAME": "Hex.pm",                   # registry display name
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
    """Pick the index URL: explicit flag > HEX_REGISTRY_URL > HEX_API_URL."""
    cfg = cfg or resolve_env()
    return explicit or cfg["HEX_REGISTRY_URL"] or cfg["HEX_API_URL"] or None


def hex_options(cfg):
    """Translate resolved config into mix/hex environment-ish flags.

    Hex exposes few invocation flags; most knobs are env vars (see
    ``hex_env``). We still surface a verbosity flag analog so verbose runs are
    self-documenting and mirror the pip reference's option list.
    """
    opts = []
    try:
        level = int(cfg["HEX_VERBOSE"])
    except (TypeError, ValueError):
        level = 0
    if level > 0:
        opts.append("--debug")  # mix: extra diagnostic output
    return opts


def hex_env(cfg):
    """Child-process environment with resolved Hex/TLS vars applied."""
    env = os.environ.copy()
    for name in _TLS_ENV_VARS:
        if cfg[name]:
            env[name] = cfg[name]
    # Thread the Hex registry/mirror/API knobs into mix so fetches hit the
    # configured registry rather than the global default.
    if cfg["HEX_MIRROR"]:
        env["HEX_MIRROR"] = cfg["HEX_MIRROR"]
    if cfg["HEX_API_URL"]:
        env["HEX_API_URL"] = cfg["HEX_API_URL"]
    if cfg["HEX_CACERTS_PATH"]:
        env["HEX_CACERTS_PATH"] = cfg["HEX_CACERTS_PATH"]
    if cfg["HEX_UNSAFE_HTTPS"] and cfg["HEX_UNSAFE_HTTPS"] != "0":
        env["HEX_UNSAFE_HTTPS"] = cfg["HEX_UNSAFE_HTTPS"]
    return env


def _api_base(index_url, cfg):
    """Derive the Hex JSON API base from the index URL or HEX_API_URL.

    The index URL the user passes is the registry root (``https://hex.pm``);
    the JSON API lives under ``/api``. If they already pointed at an ``/api``
    URL we use it as-is.
    """
    if index_url and "/api" in index_url:
        return index_url.rstrip("/")
    if index_url:
        return index_url.rstrip("/") + "/api"
    return cfg["HEX_API_URL"].rstrip("/")


def get_available_versions(package, index_url, cfg=None, verbose=False):
    """Return the list of versions the Hex registry advertises for ``package``.

    Primary source is the Hex JSON API (``/packages/<pkg>``), whose
    ``releases`` array is newest-first. If the HTTP call fails we fall back to
    parsing ``mix hex.info <pkg>``. Versions are returned newest-first. When
    ``verbose`` is set, the URL/command and raw output are echoed so a failed
    or empty discovery can be debugged.
    """
    cfg = cfg or resolve_env()
    print(f"Retrieving versions for '{package}' from {index_url}...")
    api = _api_base(index_url, cfg)
    url = f"{api}/packages/{package}"
    if verbose:
        print(f"  $ GET {url}")

    try:
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=int(cfg["HEX_HTTP_TIMEOUT"])) as resp:
            payload = resp.read().decode("utf-8")
    except Exception as e:  # noqa: BLE001 — degrade to the mix fallback
        if verbose:
            print(f"  HTTP discovery failed ({e}); falling back to 'mix hex.info'.")
        return _versions_via_mix(package, cfg, verbose=verbose)

    if verbose:
        _echo(payload)
    try:
        data = json.loads(payload)
        # ``releases`` is newest-first on the Hex API; keep that ordering.
        versions = [r["version"] for r in data.get("releases", []) if r.get("version")]
    except (ValueError, KeyError) as e:
        print(f"Could not parse Hex API JSON: {e}", file=sys.stderr)
        return []
    if not versions:
        print("No 'releases' in Hex API response.", file=sys.stderr)
    return versions


def _versions_via_mix(package, cfg=None, verbose=False):
    """Fallback discovery: parse ``mix hex.info <pkg>`` 'Releases:' line."""
    cfg = cfg or resolve_env()
    # Strip `--debug` from the discovery query: we only parse the 'Releases:'
    # line, but verbose mix floods diagnostics — a flood of output that bloats
    # the captured buffer (and overflows the Node twin's spawnSync limit). Keep
    # the discovery query quiet.
    cmd = ["mix", "hex.info", package] + _strip_verbose(hex_options(cfg))
    if verbose:
        print(f"  $ {' '.join(cmd)}")
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, check=True, env=hex_env(cfg)
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
        print(f"Error running 'mix hex.info': {detail}", file=sys.stderr)
        return []
    if verbose:
        _echo(result.stdout)
    match = re.search(r"Releases:\s*(.*)", result.stdout)
    if not match:
        print("Could not find 'Releases:' in mix output.", file=sys.stderr)
        return []
    return [v.strip() for v in match.group(1).split(",") if v.strip()]


def setup_venv(env_dir, hex_version=DEFAULT_HEX_VERSION, cfg=None, verbose=False):
    """Create a fresh scratch fetch directory if needed; return its path.

    Hex has no per-project virtualenv: the isolated sandbox is a throwaway
    directory each ``mix hex.package fetch`` writes into. The directory is
    created lazily and reused. ``hex_version`` is advisory (Hex/mix is not
    pinnable like pip); pass ``hex_version=None`` to skip the version check.
    ``verbose`` echoes the version probe so a mismatch can be debugged.
    """
    cfg = cfg or resolve_env()
    if not os.path.exists(env_dir):
        print(f"Creating fetch sandbox at: {env_dir}")
        os.makedirs(env_dir, exist_ok=True)

    if hex_version:
        _ensure_hex_version(hex_version, cfg, verbose=verbose)
    # The "handle" the test step needs is just the sandbox directory.
    return env_dir


def _ensure_hex_version(hex_version, cfg=None, verbose=False):
    """Check the installed hex/mix against ``hex_version`` (advisory only)."""
    cfg = cfg or resolve_env()
    print(f"Ensuring hex=={hex_version} in the test environment...")
    cmd = ["mix", "hex.info"]
    if verbose:
        print(f"  $ {' '.join(cmd)}")
    res = subprocess.run(cmd, capture_output=True, text=True, env=hex_env(cfg))
    if verbose:
        _echo(res.stdout, res.stderr)
    if res.returncode != 0:
        print(
            f"Warning: could not verify hex=={hex_version}: "
            f"{_last_line(res.stderr) or 'mix/hex not found'}",
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
    """True if mix ``options`` already carry a ``--debug`` flag."""
    return any(o.startswith("--debug") for o in options)


def _strip_verbose(options):
    """Return ``options`` with the ``--debug`` verbosity flag removed."""
    return [o for o in options if o != "--debug"]


def _stream(cmd, env):
    """Run ``cmd``, echoing combined output live while capturing it.

    Returns ``(returncode, combined_output)``. Used in verbose mode so the user
    watches mix in real time (e.g. a slow fetch or a hang) yet the captured
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
    first version that fetches successfully. When ``verbose`` is set, mix's full
    output is streamed live (and a ``--debug`` flag is added if none is present)
    so fetch failures can be debugged; the captured output is also folded into
    the report under ``log``/``error``.
    """
    cfg = cfg or resolve_env()
    env = hex_env(cfg)
    options = hex_options(cfg)
    results = []
    installable = []

    for idx, version in enumerate(versions, start=1):
        target = f"{package} {version}"
        print(f"[{idx}/{len(versions)}] Attempting to fetch: {target}...")

        # Each fetch lands in its own subdir of the sandbox so versions never
        # clobber one another and the sandbox stays inspectable on failure.
        out_dir = os.path.join(env_dir, f"{package}-{version}")
        cmd = [
            "mix",
            "hex.package",
            "fetch",
            package,
            version,
            "--output",
            out_dir,
        ]
        cmd += options
        # Bump mix's own verbosity if the user wants detail and nothing set it.
        if verbose and not _has_verbose(options):
            cmd.append("--debug")

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
        description="Find installable versions of a package from a Hex registry.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("package", help="Package name to probe (e.g. jason).")
    p.add_argument(
        "--index-url",
        default=None,
        help="Custom Hex registry URL. Defaults to $HEX_REGISTRY_URL, "
             "then $HEX_API_URL, then https://hex.pm.",
    )
    p.add_argument(
        "--venv-dir",
        default=".hex-test-fetch",
        help="Directory for the isolated fetch sandbox.",
    )
    p.add_argument(
        "--hex-version",
        default=DEFAULT_HEX_VERSION,
        help="hex version expected in the test sandbox ('none' to skip the check).",
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
        help="Stream full mix output for every step so failures are debuggable.",
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
          f"(registry: {cfg['HEX_REGISTRY_NAME']}).")
    hex_version = None if str(args.hex_version).lower() == "none" else args.hex_version
    env_dir = setup_venv(args.venv_dir, hex_version, cfg, verbose=args.verbose)
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
# Example — probe the newest 5 versions of jason, stop at the first fetchable:
#     main(["jason", "--index-url", "https://hex.pm",
#           "--limit", "5", "--first-only"])
#
# Equivalent on the command line:
#     python3 main.py jason \
#         --index-url https://hex.pm --limit 5 --first-only

if __name__ == "__main__":
    raise SystemExit(main())  # argv=None -> parse_args reads sys.argv
