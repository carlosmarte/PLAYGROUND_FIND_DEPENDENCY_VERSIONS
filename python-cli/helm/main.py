#!/usr/bin/env python3
"""Find pullable versions of a chart from a (custom) Helm chart repository.

Discovers every version a chart repo advertises for a chart via
``helm search repo <repo>/<chart> --versions``, then attempts to ``helm pull``
each one into an isolated destination directory, recording success/failure per
version to a JSON report.

Example:
    python main.py bitnami/nginx \
        --repo-url https://charts.bitnami.com/bitnami

    # only probe the newest 5 versions, stop at the first that pulls
    python main.py bitnami/nginx --repo-url https://charts.bitnami.com/bitnami \
        --limit 5 --first-only
"""

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile

# helm version the test environment is pinned to by default. Pull-tests run
# against this helm, so it governs repo/OCI behaviour. This is a soft pin (we
# only warn if helm reports a different version) since the helm binary is
# host-provided, not bootstrapped. Override via --helm-version (CLI) or the
# `helm` command (REPL).
DEFAULT_HELM_VERSION = "3.16.3"

# Environment knobs read via os.environ.get, each falling back to the value the
# Helm ecosystem uses by default ("industry standard"). helm itself auto-reads
# HELM_* vars from the environment; we resolve them explicitly so the documented
# default still applies when the var is unset, and so they can be surfaced (REPL
# `env`) and threaded into every helm invocation we build.
ENV_DEFAULTS = {
    "HELM_VERBOSE": "0",                                # our: quiet (0 = no --debug)
    "HELM_CACERT": "",                                  # helm: TLS CA cert file
    "HELM_REPOSITORY_CONFIG": "",                       # helm: repositories.yaml path
    "HELM_REPOSITORY_CACHE": "",                        # helm: repo cache dir
    "HELM_REPO_URL": "https://charts.helm.sh/stable",   # chart repo URL for listing
    "HELM_DEFAULT_TIMEOUT": "15",                       # our: 15s timeout hint
    "HELM_RETRIES": "5",                                # our: 5 connection retries
    "CHART_REGISTRY_URL": "https://charts.helm.sh/stable",  # our repo-url fallback
    "CHART_REGISTRY_NAME": "Helm Stable",               # registry display name
    "REQUESTS_CA_BUNDLE": "",                           # requests/urllib3: certifi
    "SSL_CERT_FILE": "",                                # OpenSSL: system CA file
    "SSL_CERT_DIR": "",                                 # OpenSSL: system CA dir
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
    """Pick the chart repo URL: explicit flag > HELM_REPO_URL > CHART_REGISTRY_URL."""
    cfg = cfg or resolve_env()
    return explicit or cfg["HELM_REPO_URL"] or cfg["CHART_REGISTRY_URL"] or None


def helm_options(cfg):
    """Translate resolved config into helm command-line flags."""
    opts = []
    try:
        level = int(cfg["HELM_VERBOSE"])
    except (TypeError, ValueError):
        level = 0
    if level > 0:
        opts.append("--debug")  # helm: verbose debug output
    if cfg["HELM_CACERT"]:
        opts += ["--ca-file", cfg["HELM_CACERT"]]
    return opts


def subprocess_env(cfg):
    """Child-process environment with resolved TLS cert vars applied."""
    env = os.environ.copy()
    for name in _TLS_ENV_VARS:
        if cfg[name]:
            env[name] = cfg[name]
    if cfg["HELM_REPOSITORY_CONFIG"]:
        env["HELM_REPOSITORY_CONFIG"] = cfg["HELM_REPOSITORY_CONFIG"]
    if cfg["HELM_REPOSITORY_CACHE"]:
        env["HELM_REPOSITORY_CACHE"] = cfg["HELM_REPOSITORY_CACHE"]
    return env


def _split_chart(package):
    """Split ``<repo>/<chart>`` into ``(repo_alias, chart)``.

    helm references charts as ``<repo-alias>/<chart>``; the alias is a local name
    registered with ``helm repo add``. When no slash is present we treat the
    whole token as the chart and synthesize a stable alias.
    """
    if "/" in package:
        alias, chart = package.split("/", 1)
        return alias, chart
    return "probe", package


def _repo_add(alias, repo_url, cfg, verbose=False):
    """Register the chart repo locally so ``search``/``pull`` can resolve it."""
    cmd = ["helm", "repo", "add", alias, repo_url] + helm_options(cfg)
    if verbose:
        print(f"  $ {' '.join(cmd)}")
    res = subprocess.run(cmd, capture_output=True, text=True, env=subprocess_env(cfg))
    if verbose:
        _echo(res.stdout, res.stderr)
    # Refresh the index so search sees the latest versions.
    upd = ["helm", "repo", "update", alias] + helm_options(cfg)
    if verbose:
        print(f"  $ {' '.join(upd)}")
    subprocess.run(upd, capture_output=True, text=True, env=subprocess_env(cfg))


def get_available_versions(package, index_url, cfg=None, verbose=False):
    """Return the list of versions a chart repo advertises for ``package``.

    Versions are returned newest-first, mirroring ``helm search repo --versions``
    (which lists newest first). When ``verbose`` is set, the helm command and its
    raw output are echoed so a failed or empty discovery can be debugged.
    """
    cfg = cfg or resolve_env()
    print(f"Retrieving versions for '{package}' from {index_url}...")
    alias, chart = _split_chart(package)
    if index_url:
        _repo_add(alias, index_url, cfg, verbose=verbose)

    cmd = [
        "helm",
        "search",
        "repo",
        f"{alias}/{chart}",
        "--versions",
        "--output",
        "json",
    ]
    cmd += helm_options(cfg)
    if verbose:
        print(f"  $ {' '.join(cmd)}")

    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, check=True, env=subprocess_env(cfg)
        )
    except subprocess.CalledProcessError as e:
        if verbose:
            _echo(e.stdout, e.stderr)
        print(f"Error running 'helm search repo': {e.stderr.strip()}", file=sys.stderr)
        sys.exit(1)

    if verbose:
        _echo(result.stdout)
    try:
        entries = json.loads(result.stdout or "[]")
    except json.JSONDecodeError:
        print("Could not parse JSON from helm output.", file=sys.stderr)
        return []
    return [e["version"] for e in entries if e.get("version")]


def setup_venv(env_dir, helm_version=DEFAULT_HELM_VERSION, cfg=None, verbose=False):
    """Create a fresh pull-destination directory if needed; return its path.

    For helm the "sandbox" is a scratch destination directory that each
    ``helm pull --destination`` writes chart archives into. The helm binary is
    pinned to ``helm_version`` (default ``DEFAULT_HELM_VERSION``) as a *soft*
    check — we warn on mismatch rather than bootstrap a binary. Pass
    ``helm_version=None`` to skip the check. ``verbose`` echoes the version
    output so a failed check can be debugged.
    """
    cfg = cfg or resolve_env()
    if not os.path.exists(env_dir):
        print(f"Creating chart destination at: {env_dir}")
        os.makedirs(env_dir, exist_ok=True)

    # The "tool path" for helm is the destination dir; pulls land there and the
    # helm binary is on PATH (macOS / Linux / nt all use the same name).
    dest_path = env_dir

    if helm_version:
        _ensure_helm_version(dest_path, helm_version, cfg, verbose=verbose)
    return dest_path


def _ensure_helm_version(dest_path, helm_version, cfg=None, verbose=False):
    """Verify the helm binary reports ``helm_version`` (soft pin; warns)."""
    cfg = cfg or resolve_env()
    print(f"Ensuring helm=={helm_version} in the test environment...")
    cmd = ["helm", "version", "--template", "{{.Version}}"] + helm_options(cfg)
    if verbose:
        print(f"  $ {' '.join(cmd)}")
    res = subprocess.run(cmd, capture_output=True, text=True, env=subprocess_env(cfg))
    if verbose:
        _echo(res.stdout, res.stderr)
    found = _last_line(res.stdout).lstrip("v")
    if res.returncode != 0 or found != helm_version:
        print(
            f"Warning: could not pin helm=={helm_version}: "
            f"binary reports {found or 'unknown error'}",
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
    """True if helm ``options`` already carry a ``--debug`` flag."""
    return any(o == "--debug" for o in options)


def _stream(cmd, env):
    """Run ``cmd``, echoing combined output live while capturing it.

    Returns ``(returncode, combined_output)``. Used in verbose mode so the user
    watches helm in real time (e.g. a slow download or a hang) yet the captured
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


def test_installations(dest_path, package, index_url, versions, output_json,
                       first_only=False, cfg=None, verbose=False):
    """Attempt to ``helm pull`` each version; write an incremental JSON report.

    Returns the list of result dicts. If ``first_only`` is set, stops after
    the first version that pulls successfully. When ``verbose`` is set, helm's
    full output is streamed live (and a ``--debug`` flag is added if none is
    present) so pull failures can be debugged; the captured output is also
    folded into the report under ``log``/``error``.
    """
    cfg = cfg or resolve_env()
    env = subprocess_env(cfg)
    options = helm_options(cfg)
    alias, chart = _split_chart(package)
    results = []
    installable = []

    for idx, version in enumerate(versions, start=1):
        target = f"{alias}/{chart}:{version}"
        print(f"[{idx}/{len(versions)}] Attempting to pull: {target}...")

        # Each version downloads into its own scratch dir under the destination
        # so successive pulls do not collide on archive filenames.
        scratch = tempfile.mkdtemp(prefix="helm-", dir=dest_path)
        cmd = [
            "helm",
            "pull",
            f"{alias}/{chart}",
            "--version",
            version,
            "--destination",
            scratch,
        ]
        cmd += options
        # Bump helm's own verbosity if the user wants detail and nothing set it.
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
            print(f"  First pullable version found: {installable[0]} (stopping).")
            break

    print(f"\nTesting complete! Results saved to {output_json}")
    if installable:
        print(f"Pullable versions ({len(installable)}): {', '.join(installable)}")
    else:
        print("No pullable versions found.")
    return results


def parse_args(argv=None):
    p = argparse.ArgumentParser(
        description="Find pullable versions of a chart from a Helm repository.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("package", help="Chart to probe as <repo>/<chart> (e.g. bitnami/nginx).")
    p.add_argument(
        "--repo-url",
        dest="index_url",
        default=None,
        help="Custom chart repository URL. Defaults to $HELM_REPO_URL, "
             "then $CHART_REGISTRY_URL, then https://charts.helm.sh/stable.",
    )
    p.add_argument(
        "--venv-dir",
        default=".venv-test-install",
        help="Directory for the isolated chart-pull destination.",
    )
    p.add_argument(
        "--helm-version",
        default=DEFAULT_HELM_VERSION,
        help="helm version to expect ('none' to skip the check).",
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
        help="Stop after the first version that pulls successfully.",
    )
    p.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="Stream full helm output for every step so failures are debuggable.",
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
          f"(registry: {cfg['CHART_REGISTRY_NAME']}).")
    helm_version = None if str(args.helm_version).lower() == "none" else args.helm_version
    dest_path = setup_venv(args.venv_dir, helm_version, cfg, verbose=args.verbose)
    test_installations(
        dest_path,
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
# Example — probe the newest 5 versions of bitnami/nginx, stop at the first pullable:
#     main(["bitnami/nginx", "--repo-url", "https://charts.bitnami.com/bitnami",
#           "--limit", "5", "--first-only"])
#
# Equivalent on the command line:
#     python3 main.py bitnami/nginx \
#         --repo-url https://charts.bitnami.com/bitnami --limit 5 --first-only

if __name__ == "__main__":
    raise SystemExit(main())  # argv=None -> parse_args reads sys.argv
