#!/usr/bin/env python3
"""Find pullable tags of an image from a (custom) container registry.

Discovers every tag a registry advertises for a repository via the registry v2
``/v2/<repo>/tags/list`` API (or the Docker Hub ``/v2/repositories`` API), then
attempts to ``docker pull`` each one into the local daemon, recording
success/failure per tag to a JSON report.

Example:
    python main.py library/nginx \
        --registry registry-1.docker.io

    # only probe the newest 5 tags, stop at the first that pulls
    python main.py library/nginx --registry registry-1.docker.io \
        --limit 5 --first-only
"""

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request

# docker CLI version the test environment is pinned to by default. Pull-tests
# run against this docker, so it governs daemon/registry behaviour. This is a
# soft pin (we only warn if the daemon reports a different version) since the
# docker client is host-provided, not bootstrapped. Override via --docker-version
# (CLI) or the `docker` command (REPL).
DEFAULT_DOCKER_VERSION = "27.3.1"

# Environment knobs read via os.environ.get, each falling back to the value the
# container ecosystem uses by default ("industry standard"). docker itself
# auto-reads DOCKER_* vars from the environment; we resolve them explicitly so
# the documented default still applies when the var is unset, and so they can be
# surfaced (REPL `env`) and threaded into every docker invocation we build.
ENV_DEFAULTS = {
    "DOCKER_VERBOSE": "0",                              # our: quiet (0 = no debug)
    "DOCKER_CERT_PATH": "",                             # docker: TLS client certs dir
    "DOCKER_TLS_VERIFY": "",                            # docker: verify daemon TLS
    "DOCKER_HOST": "",                                  # docker: daemon socket/host
    "DOCKER_REGISTRY": "registry-1.docker.io",          # registry v2 host for listing
    "DOCKER_DEFAULT_TIMEOUT": "15",                     # our: 15s HTTP timeout
    "DOCKER_RETRIES": "5",                              # our: 5 connection retries
    "CONTAINER_REGISTRY_URL": "registry-1.docker.io",   # our registry-host fallback
    "CONTAINER_REGISTRY_NAME": "Docker Hub",            # registry display name
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
    """Pick the registry host: explicit flag > DOCKER_REGISTRY > CONTAINER_REGISTRY_URL."""
    cfg = cfg or resolve_env()
    return explicit or cfg["DOCKER_REGISTRY"] or cfg["CONTAINER_REGISTRY_URL"] or None


def docker_options(cfg):
    """Translate resolved config into docker command-line flags."""
    opts = []
    try:
        level = int(cfg["DOCKER_VERBOSE"])
    except (TypeError, ValueError):
        level = 0
    if level > 0:
        opts.append("--debug")  # docker: client debug output
    if cfg["DOCKER_HOST"]:
        opts += ["--host", cfg["DOCKER_HOST"]]
    if cfg["DOCKER_TLS_VERIFY"]:
        opts += ["--tlsverify"]
    if cfg["DOCKER_CERT_PATH"]:
        opts += ["--tlscacert", os.path.join(cfg["DOCKER_CERT_PATH"], "ca.pem")]
    return opts


def subprocess_env(cfg):
    """Child-process environment with resolved TLS cert vars applied."""
    env = os.environ.copy()
    for name in _TLS_ENV_VARS:
        if cfg[name]:
            env[name] = cfg[name]
    if cfg["DOCKER_CERT_PATH"]:
        env["DOCKER_CERT_PATH"] = cfg["DOCKER_CERT_PATH"]
    return env


def _http_get_json(url, cfg, headers=None, verbose=False):
    """GET ``url`` and parse a JSON body via stdlib urllib (no third-party deps).

    Returns the decoded JSON object, or ``None`` on any HTTP/parse error (the
    caller degrades gracefully). ``verbose`` echoes the request and any error.
    """
    try:
        timeout = int(cfg["DOCKER_DEFAULT_TIMEOUT"])
    except (TypeError, ValueError):
        timeout = 15
    req = urllib.request.Request(url, headers=headers or {})
    if verbose:
        print(f"  $ GET {url}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, ValueError) as e:
        if verbose:
            print(f"  ! {e}")
        return None


def _pull_token(repo, cfg, verbose=False):
    """Fetch an anonymous Docker Hub pull token for ``repo`` (scope-limited).

    The registry v2 ``tags/list`` endpoint on Docker Hub requires a bearer token
    even for public images; we mint a read-only one from auth.docker.io. Returns
    the token string, or ``None`` when no auth is needed/available.
    """
    url = (
        "https://auth.docker.io/token"
        f"?service=registry.docker.io&scope=repository:{repo}:pull"
    )
    data = _http_get_json(url, cfg, verbose=verbose)
    return (data or {}).get("token")


def get_available_versions(package, index_url, cfg=None, verbose=False):
    """Return the list of tags a registry advertises for ``package``.

    Tags are returned newest-first. We prefer the Docker Hub ``/v2/repositories``
    API (which sorts by last-pushed) and fall back to the registry v2
    ``/v2/<repo>/tags/list`` (with an anonymous pull token). When ``verbose`` is
    set, the requests and raw responses are echoed so a failed or empty discovery
    can be debugged.
    """
    cfg = cfg or resolve_env()
    print(f"Retrieving tags for '{package}' from {index_url}...")

    # Preferred path: Docker Hub's repositories API returns newest-first tags.
    hub_url = (
        f"https://hub.docker.com/v2/repositories/{package}/tags"
        "?page_size=100&ordering=last_updated"
    )
    data = _http_get_json(hub_url, cfg, verbose=verbose)
    if data and isinstance(data.get("results"), list):
        tags = [r["name"] for r in data["results"] if r.get("name")]
        if tags:
            return tags

    # Fallback: registry v2 tags/list (alphabetical) — reverse to approximate
    # newest-first, after minting an anonymous pull token for Docker Hub.
    token = _pull_token(package, cfg, verbose=verbose)
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    v2_url = f"https://{index_url}/v2/{package}/tags/list"
    data = _http_get_json(v2_url, cfg, headers=headers, verbose=verbose)
    if not data or not isinstance(data.get("tags"), list):
        print("Could not find 'tags' in registry response.", file=sys.stderr)
        return []
    return list(reversed([t for t in data["tags"] if t]))


def setup_venv(env_dir, docker_version=DEFAULT_DOCKER_VERSION, cfg=None, verbose=False):
    """Prepare an isolated pull sandbox if needed; return its scratch dir.

    For docker the "sandbox" is just a scratch directory used to mark the session
    (the pulled images land in the shared local daemon, which has no per-call
    isolation). The docker client is pinned to ``docker_version`` (default
    ``DEFAULT_DOCKER_VERSION``) as a *soft* check — we warn on mismatch rather
    than bootstrap a client. Pass ``docker_version=None`` to skip the check.
    ``verbose`` echoes the version output so a failed check can be debugged.
    """
    cfg = cfg or resolve_env()
    if not os.path.exists(env_dir):
        print(f"Creating sandbox directory at: {env_dir}")
        os.makedirs(env_dir, exist_ok=True)

    # The "tool path" for docker is just the docker executable name; the daemon
    # is shared, so there is no per-env binary to locate (macOS / Linux / nt).
    docker_path = "docker"

    if docker_version:
        _ensure_docker_version(docker_path, docker_version, cfg, verbose=verbose)
    return docker_path


def _ensure_docker_version(docker_path, docker_version, cfg=None, verbose=False):
    """Verify the docker client reports ``docker_version`` (soft pin; warns)."""
    cfg = cfg or resolve_env()
    print(f"Ensuring docker=={docker_version} in the test environment...")
    cmd = [docker_path] + docker_options(cfg) + ["version", "--format", "{{.Client.Version}}"]
    if verbose:
        print(f"  $ {' '.join(cmd)}")
    res = subprocess.run(cmd, capture_output=True, text=True, env=subprocess_env(cfg))
    if verbose:
        _echo(res.stdout, res.stderr)
    found = _last_line(res.stdout)
    if res.returncode != 0 or found != docker_version:
        print(
            f"Warning: could not pin docker=={docker_version}: "
            f"client reports {found or 'unknown error'}",
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
    """True if docker ``options`` already carry a ``--debug`` flag."""
    return any(o == "--debug" for o in options)


def _stream(cmd, env):
    """Run ``cmd``, echoing combined output live while capturing it.

    Returns ``(returncode, combined_output)``. Used in verbose mode so the user
    watches docker in real time (e.g. a slow layer pull or a hang) yet the
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


def test_installations(docker_path, package, index_url, versions, output_json,
                       first_only=False, cfg=None, verbose=False):
    """Attempt to ``docker pull`` each tag; write an incremental JSON report.

    Returns the list of result dicts. If ``first_only`` is set, stops after
    the first tag that pulls successfully. When ``verbose`` is set, docker's
    full output is streamed live (and a ``--debug`` flag is added if none is
    present) so pull failures can be debugged; the captured output is also
    folded into the report under ``log``/``error``.
    """
    cfg = cfg or resolve_env()
    env = subprocess_env(cfg)
    options = docker_options(cfg)
    results = []
    installable = []

    for idx, version in enumerate(versions, start=1):
        # docker pull targets a fully-qualified <registry>/<repo>:<tag> ref.
        ref = f"{index_url}/{package}:{version}" if index_url else f"{package}:{version}"
        target = f"{package}:{version}"
        print(f"[{idx}/{len(versions)}] Attempting to pull: {target}...")

        cmd = [docker_path]
        # Bump docker's own verbosity if the user wants detail and nothing set it.
        if verbose and not _has_verbose(options):
            cmd.append("--debug")
        cmd += options
        cmd += ["pull", ref]

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
            print(f"  First pullable tag found: {installable[0]} (stopping).")
            break

    print(f"\nTesting complete! Results saved to {output_json}")
    if installable:
        print(f"Pullable tags ({len(installable)}): {', '.join(installable)}")
    else:
        print("No pullable tags found.")
    return results


def parse_args(argv=None):
    p = argparse.ArgumentParser(
        description="Find pullable tags of an image from a container registry.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("package", help="Repository to probe (e.g. library/nginx).")
    p.add_argument(
        "--registry",
        dest="index_url",
        default=None,
        help="Custom registry host. Defaults to $DOCKER_REGISTRY, "
             "then $CONTAINER_REGISTRY_URL, then registry-1.docker.io.",
    )
    p.add_argument(
        "--venv-dir",
        default=".venv-test-install",
        help="Directory for the isolated pull sandbox.",
    )
    p.add_argument(
        "--docker-version",
        default=DEFAULT_DOCKER_VERSION,
        help="docker client version to expect ('none' to skip the check).",
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
        help="Only test the newest N tags (default: all).",
    )
    p.add_argument(
        "--first-only",
        action="store_true",
        help="Stop after the first tag that pulls successfully.",
    )
    p.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="Stream full docker output for every step so failures are debuggable.",
    )
    return p.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)

    cfg = resolve_env()
    index_url = resolve_index_url(args.index_url, cfg)

    versions = get_available_versions(args.package, index_url, cfg, verbose=args.verbose)
    if not versions:
        print("No tags found. Exiting.")
        return 1

    if args.limit is not None:
        versions = versions[: args.limit]

    print(f"Found {len(versions)} tag(s) to test "
          f"(registry: {cfg['CONTAINER_REGISTRY_NAME']}).")
    docker_version = None if str(args.docker_version).lower() == "none" else args.docker_version
    docker_path = setup_venv(args.venv_dir, docker_version, cfg, verbose=args.verbose)
    test_installations(
        docker_path,
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
# Example — probe the newest 5 tags of library/nginx, stop at the first pullable:
#     main(["library/nginx", "--registry", "registry-1.docker.io",
#           "--limit", "5", "--first-only"])
#
# Equivalent on the command line:
#     python3 main.py library/nginx \
#         --registry registry-1.docker.io --limit 5 --first-only

if __name__ == "__main__":
    raise SystemExit(main())  # argv=None -> parse_args reads sys.argv
