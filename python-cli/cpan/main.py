#!/usr/bin/env python3
"""Find installable versions of a package from a (custom) CPAN registry.

Discovers every version CPAN advertises for a distribution via the MetaCPAN
HTTP JSON API (``/v1/release/_search?q=distribution:<Dist>&fields=version``),
then attempts to install each one into an isolated ``--local-lib`` prefix with
``cpanm``, recording success/failure per version to a JSON report.

Example:
    python main.py JSON \
        --index-url https://www.cpan.org

    # only probe the newest 5 versions, stop at the first that installs
    python main.py JSON --index-url https://www.cpan.org \
        --limit 5 --first-only
"""

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request

# cpanm tool version the test environment expects by default. Install-tests run
# against this cpanm, so it governs resolver/fetch behaviour. Override via
# --cpanm-version (CLI) or the `cpanm` command (REPL). cpanm is not pinnable the
# way pip is, so this is advisory: we surface it and warn on a mismatch.
DEFAULT_CPANM_VERSION = "1.7047"

# Environment knobs read via os.environ.get, each falling back to the value the
# Perl / cpanm / TLS ecosystem uses by default ("industry standard"). cpanm
# auto-reads PERL_CPANM_* vars from the environment; we resolve them explicitly
# so the documented default still applies when the var is unset, and so they can
# be surfaced (REPL `env`) and threaded into every cpanm invocation we build.
ENV_DEFAULTS = {
    "PERL_CPANM_VERBOSE": "0",                       # cpanm: quiet (0 = no --verbose)
    "PERL_CPANM_CERT": "",                           # cpanm: use system CA store
    "CPAN_META_URL": "https://fastapi.metacpan.org/v1",  # MetaCPAN JSON API base
    "PERL_CPANM_MIRROR": "https://www.cpan.org",     # cpanm: --mirror base
    "PERL_CPANM_INSECURE": "0",                       # cpanm: keep TLS verification
    "PERL_CPANM_TIMEOUT": "15",                      # cpanm: 15s socket timeout
    "PERL_CPANM_RETRIES": "5",                       # advisory: fetch retries
    "CPAN_REGISTRY_URL": "https://www.cpan.org",     # our index-url fallback
    "CPAN_REGISTRY_NAME": "CPAN",                    # registry display name
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
    """Pick the index URL: explicit flag > CPAN_REGISTRY_URL > PERL_CPANM_MIRROR."""
    cfg = cfg or resolve_env()
    return explicit or cfg["CPAN_REGISTRY_URL"] or cfg["PERL_CPANM_MIRROR"] or None


def cpanm_options(cfg):
    """Translate resolved config into cpanm command-line flags."""
    opts = []
    try:
        level = int(cfg["PERL_CPANM_VERBOSE"])
    except (TypeError, ValueError):
        level = 0
    if level > 0:
        opts.append("--verbose")  # cpanm: chatty build output
    if cfg["PERL_CPANM_INSECURE"] and cfg["PERL_CPANM_INSECURE"] != "0":
        opts.append("--insecure")
    opts += ["--timeout", str(cfg["PERL_CPANM_TIMEOUT"])]
    return opts


def subprocess_env(cfg):
    """Child-process environment with resolved cpanm/TLS vars applied."""
    env = os.environ.copy()
    for name in _TLS_ENV_VARS:
        if cfg[name]:
            env[name] = cfg[name]
    if cfg["PERL_CPANM_CERT"]:
        env["PERL_CPANM_CERT"] = cfg["PERL_CPANM_CERT"]
    return env


def _meta_base(index_url, cfg):
    """Derive the MetaCPAN JSON API base.

    The index URL the user passes is the CPAN mirror (``https://www.cpan.org``)
    used for *installs*; version *discovery* always goes through MetaCPAN's
    JSON API (``$CPAN_META_URL``), which the mirror does not serve.
    """
    return cfg["CPAN_META_URL"].rstrip("/")


def get_available_versions(package, index_url, cfg=None, verbose=False):
    """Return the list of versions CPAN advertises for ``package``.

    ``package`` may be a module (``JSON::PP``) or a distribution (``JSON``); we
    query MetaCPAN's release search by distribution, whose results we sort
    newest-first. When ``verbose`` is set, the URL and raw output are echoed so
    a failed or empty discovery can be debugged.
    """
    cfg = cfg or resolve_env()
    print(f"Retrieving versions for '{package}' from {index_url}...")
    base = _meta_base(index_url, cfg)
    # A module name (Foo::Bar) maps to a distribution (Foo-Bar) on MetaCPAN.
    dist = package.replace("::", "-")
    query = urllib.parse.urlencode({
        "q": f"distribution:{dist}",
        "fields": "version,date",
        "size": "100",
        "sort": "date:desc",
    })
    url = f"{base}/release/_search?{query}"
    if verbose:
        print(f"  $ GET {url}")

    try:
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=int(cfg["PERL_CPANM_TIMEOUT"])) as resp:
            payload = resp.read().decode("utf-8")
    except Exception as e:  # noqa: BLE001
        print(f"Error querying MetaCPAN: {e}", file=sys.stderr)
        return []

    if verbose:
        _echo(payload)
    try:
        data = json.loads(payload)
        hits = data.get("hits", {}).get("hits", [])
        # Sorted newest-first by date via the query; dedupe preserving order.
        versions = []
        seen = set()
        for h in hits:
            v = str(h.get("fields", {}).get("version", "")).strip()
            if v and v not in seen:
                seen.add(v)
                versions.append(v)
    except (ValueError, KeyError) as e:
        print(f"Could not parse MetaCPAN JSON: {e}", file=sys.stderr)
        return []
    if not versions:
        print("No releases found on MetaCPAN.", file=sys.stderr)
    return versions


def setup_venv(env_dir, cpanm_version=DEFAULT_CPANM_VERSION, cfg=None, verbose=False):
    """Create a fresh local-lib prefix if needed; return its path.

    Perl has no per-project virtualenv: the isolated sandbox is a throwaway
    ``--local-lib`` directory each ``cpanm`` installs into. The directory is
    created lazily and reused. ``cpanm_version`` is advisory (cpanm is not
    pinnable like pip); pass ``cpanm_version=None`` to skip the version check.
    ``verbose`` echoes the version probe so a mismatch can be debugged.
    """
    cfg = cfg or resolve_env()
    if not os.path.exists(env_dir):
        print(f"Creating local-lib sandbox at: {env_dir}")
        os.makedirs(env_dir, exist_ok=True)

    if cpanm_version:
        _ensure_cpanm_version(cpanm_version, cfg, verbose=verbose)
    # The "handle" the test step needs is just the local-lib directory.
    return env_dir


def _ensure_cpanm_version(cpanm_version, cfg=None, verbose=False):
    """Check the installed cpanm against ``cpanm_version`` (advisory only)."""
    cfg = cfg or resolve_env()
    print(f"Ensuring cpanm=={cpanm_version} in the test environment...")
    cmd = ["cpanm", "--version"]
    if verbose:
        print(f"  $ {' '.join(cmd)}")
    res = subprocess.run(cmd, capture_output=True, text=True, env=subprocess_env(cfg))
    if verbose:
        _echo(res.stdout, res.stderr)
    if res.returncode != 0:
        print(
            f"Warning: could not verify cpanm=={cpanm_version}: "
            f"{_last_line(res.stderr) or 'cpanm not found'}",
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
    """True if cpanm ``options`` already carry a ``--verbose`` flag."""
    return any(o.startswith("--verbose") for o in options)


def _stream(cmd, env):
    """Run ``cmd``, echoing combined output live while capturing it.

    Returns ``(returncode, combined_output)``. Used in verbose mode so the user
    watches cpanm in real time (e.g. a slow build or a hang) yet the captured
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
    """Attempt to install each version; write an incremental JSON report.

    Returns the list of result dicts. If ``first_only`` is set, stops after the
    first version that installs successfully. When ``verbose`` is set, cpanm's
    full output is streamed live (and a ``--verbose`` flag is added if none is
    present) so install failures can be debugged; the captured output is also
    folded into the report under ``log``/``error``.
    """
    cfg = cfg or resolve_env()
    env = subprocess_env(cfg)
    options = cpanm_options(cfg)
    results = []
    installable = []

    for idx, version in enumerate(versions, start=1):
        target = f"{package}@{version}"
        print(f"[{idx}/{len(versions)}] Attempting to install: {target}...")

        # Each version installs into its own local-lib subdir so versions never
        # clobber one another and the sandbox stays inspectable on failure.
        local_lib = os.path.join(env_dir, f"{package.replace('::', '-')}-{version}")
        cmd = [
            "cpanm",
            "--local-lib",
            local_lib,
            "--notest",
            target,
        ]
        cmd += options
        if index_url:
            cmd += ["--mirror", index_url, "--mirror-only"]
        # Bump cpanm's own verbosity if the user wants detail and nothing set it.
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
        description="Find installable versions of a package from a CPAN registry.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("package", help="Module or distribution to probe (e.g. JSON).")
    p.add_argument(
        "--index-url",
        default=None,
        help="Custom CPAN mirror URL. Defaults to $CPAN_REGISTRY_URL, "
             "then $PERL_CPANM_MIRROR, then https://www.cpan.org.",
    )
    p.add_argument(
        "--venv-dir",
        default=".cpan-test-lib",
        help="Directory for the isolated local-lib sandbox.",
    )
    p.add_argument(
        "--cpanm-version",
        default=DEFAULT_CPANM_VERSION,
        help="cpanm version expected in the test sandbox ('none' to skip the check).",
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
        help="Stream full cpanm output for every step so failures are debuggable.",
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
          f"(registry: {cfg['CPAN_REGISTRY_NAME']}).")
    cpanm_version = None if str(args.cpanm_version).lower() == "none" else args.cpanm_version
    env_dir = setup_venv(args.venv_dir, cpanm_version, cfg, verbose=args.verbose)
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
# Example — probe the newest 5 versions of JSON, stop at the first installable:
#     main(["JSON", "--index-url", "https://www.cpan.org",
#           "--limit", "5", "--first-only"])
#
# Equivalent on the command line:
#     python3 main.py JSON \
#         --index-url https://www.cpan.org --limit 5 --first-only

if __name__ == "__main__":
    raise SystemExit(main())  # argv=None -> parse_args reads sys.argv
