#!/usr/bin/env python3
"""Find resolvable versions of an artifact from a (custom) Maven repository.

Discovers every version a repository advertises for a ``groupId:artifactId``
coordinate via the artifact's ``maven-metadata.xml``, then attempts to resolve
each one into an isolated local Maven repository, recording success/failure per
version to a JSON report.

Example:
    python main.py com.google.guava:guava \
        --repo-url https://repo1.maven.org/maven2

    # only probe the newest 5 versions, stop at the first that resolves
    python main.py com.google.guava:guava --repo-url https://repo/maven2 \
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
import xml.etree.ElementTree as ET

# maven version the test environment is pinned to by default. Resolve-tests run
# against this maven, so it governs resolver/repository behaviour. Override via
# --maven-version (CLI) or the `maven` command (REPL).
DEFAULT_MAVEN_VERSION = "3.9.9"

# Environment knobs read via os.environ.get, each falling back to the value the
# Maven / JVM ecosystem uses by default ("industry standard"). Maven itself
# auto-reads settings from the environment; we resolve them explicitly so the
# documented default still applies when the var is unset, and so they can be
# surfaced (REPL `env`) and threaded into every mvn invocation we build.
ENV_DEFAULTS = {
    "MAVEN_VERBOSE": "0",                                  # mvn: quiet (0 = no -X)
    "MAVEN_TRANSFER_TIMEOUT": "15",                        # mvn: 15s transfer timeout
    "MAVEN_REPO_URL": "https://repo1.maven.org/maven2",    # mvn: remote repo base
    "MAVEN_OPTS": "",                                      # mvn: extra JVM opts
    "JVM_REGISTRY_URL": "https://repo1.maven.org/maven2",  # our repo-url fallback
    "JVM_REGISTRY_NAME": "Maven Central",                  # registry display name
    "MAVEN_USER_AGENT": "",                                # http: optional UA override
    "HTTPS_PROXY": "",                                     # http: optional proxy
    "HTTP_PROXY": "",                                      # http: optional proxy
    "NO_PROXY": "",                                        # http: proxy bypass list
}

# HTTP/proxy vars passed through to child processes via the environment (no CLI flag).
_TLS_ENV_VARS = ("HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY")


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
    """Pick the repo URL: explicit flag > MAVEN_REPO_URL > JVM_REGISTRY_URL."""
    cfg = cfg or resolve_env()
    return explicit or cfg["MAVEN_REPO_URL"] or cfg["JVM_REGISTRY_URL"] or None


def maven_options(cfg):
    """Translate resolved config into mvn command-line flags."""
    opts = []
    try:
        level = int(cfg["MAVEN_VERBOSE"])
    except (TypeError, ValueError):
        level = 0
    if level > 0:
        opts.append("-X")  # maven debug output
    # Bound the remote transfer so a hung mirror fails fast rather than blocking.
    opts += ["-Dmaven.wagon.httpconnectionManager.ttlSeconds=" + str(cfg["MAVEN_TRANSFER_TIMEOUT"])]
    return opts


def subprocess_env(cfg):
    """Child-process environment with resolved HTTP/proxy vars applied."""
    env = os.environ.copy()
    for name in _TLS_ENV_VARS:
        if cfg[name]:
            env[name] = cfg[name]
    if cfg["MAVEN_OPTS"]:
        env["MAVEN_OPTS"] = cfg["MAVEN_OPTS"]
    return env


def _split_coordinate(package):
    """Split ``groupId:artifactId`` into a ``(group, artifact)`` pair."""
    if ":" not in package:
        print(
            f"Coordinate must be 'groupId:artifactId' (got {package!r}).",
            file=sys.stderr,
        )
        sys.exit(1)
    group, artifact = package.split(":", 1)
    return group.strip(), artifact.strip()


def get_available_versions(package, index_url, cfg=None, verbose=False):
    """Return the list of versions a repository advertises for ``package``.

    Versions are returned newest-first, parsed from the artifact's
    ``maven-metadata.xml`` (``<repo>/<group-as-path>/<artifact>/maven-metadata.xml``)
    with the stdlib XML parser. When ``verbose`` is set, the metadata URL and its
    raw body are echoed so a failed or empty discovery can be debugged.
    """
    cfg = cfg or resolve_env()
    group, artifact = _split_coordinate(package)
    base = (index_url or cfg["MAVEN_REPO_URL"]).rstrip("/")
    group_path = group.replace(".", "/")
    url = f"{base}/{group_path}/{artifact}/maven-metadata.xml"
    print(f"Retrieving versions for '{package}' from {url}...")
    if verbose:
        print(f"  $ GET {url}")

    try:
        with urllib.request.urlopen(url, timeout=int(cfg["MAVEN_TRANSFER_TIMEOUT"])) as resp:
            body = resp.read().decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001 - any fetch failure is a hard discovery error
        print(f"Error fetching maven-metadata.xml: {e}", file=sys.stderr)
        sys.exit(1)

    if verbose:
        _echo(body)
    try:
        root = ET.fromstring(body)
    except ET.ParseError as e:
        print(f"Could not parse maven-metadata.xml: {e}", file=sys.stderr)
        return []
    # <metadata><versioning><versions><version>...</version></versions></versioning>
    versions = [el.text.strip() for el in root.iter("version") if el.text and el.text.strip()]
    if not versions:
        print("Could not find any <version> elements in maven-metadata.xml.", file=sys.stderr)
        return []
    # maven-metadata.xml lists oldest-first; reverse so newest leads (mirrors pip).
    return list(reversed(versions))


def setup_venv(env_dir, maven_version=DEFAULT_MAVEN_VERSION, cfg=None, verbose=False):
    """Create a fresh isolated local Maven repository if needed; return its path.

    The sandbox is a throwaway directory used as ``-Dmaven.repo.local`` so every
    resolve-test fetches fresh into a known location, isolated from the host's
    ``~/.m2``. ``maven_version`` is recorded for parity with the reference (the
    test step runs against whatever ``mvn`` is on PATH); pass
    ``maven_version=None`` to skip the version check. ``verbose`` echoes the
    maven-version output so a failed check can be debugged.
    """
    cfg = cfg or resolve_env()
    if not os.path.exists(env_dir):
        print(f"Creating local Maven repository at: {env_dir}")
        os.makedirs(env_dir, exist_ok=True)

    if maven_version:
        _ensure_maven_version(maven_version, cfg, verbose=verbose)
    # The "handle" the test step needs is just the local-repo path.
    return env_dir


def _ensure_maven_version(maven_version, cfg=None, verbose=False):
    """Check the ``mvn`` on PATH and warn if it differs from ``maven_version``."""
    cfg = cfg or resolve_env()
    print(f"Ensuring maven=={maven_version} in the test environment...")
    cmd = ["mvn", "--version"]
    if verbose:
        print(f"  $ {' '.join(cmd)}")
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, env=subprocess_env(cfg))
    except FileNotFoundError:
        print(
            f"Warning: could not pin maven=={maven_version}: mvn not found on PATH",
            file=sys.stderr,
        )
        return
    if verbose:
        _echo(res.stdout, res.stderr)
    if res.returncode != 0 or maven_version not in (res.stdout or ""):
        # A negative returncode means the child was killed by a signal, leaving
        # output empty — fall back to the signal name so the failure isn't blank.
        detail = _last_line(res.stdout) or _last_line(res.stderr)
        if not detail and res.returncode is not None and res.returncode < 0:
            try:
                detail = f"terminated by signal {signal.Signals(-res.returncode).name}"
            except ValueError:
                detail = f"terminated by signal {-res.returncode}"
        print(
            f"Warning: could not pin maven=={maven_version}: "
            f"{detail or 'unknown error'}",
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
    """True if mvn ``options`` already carry a ``-X`` debug flag."""
    return any(o == "-X" for o in options)


def _stream(cmd, env):
    """Run ``cmd``, echoing combined output live while capturing it.

    Returns ``(returncode, combined_output)``. Used in verbose mode so the user
    watches mvn in real time (e.g. a slow build or a hang) yet the captured text
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


def test_installations(repo_local, package, index_url, versions, output_json,
                       first_only=False, cfg=None, verbose=False):
    """Attempt to resolve each version; write an incremental JSON report.

    Returns the list of result dicts. If ``first_only`` is set, stops after
    the first version that resolves successfully. When ``verbose`` is set, mvn's
    full output is streamed live (and a ``-X`` flag is added if none is present)
    so resolution failures can be debugged; the captured output is also folded
    into the report under ``log``/``error``.
    """
    cfg = cfg or resolve_env()
    env = subprocess_env(cfg)
    options = maven_options(cfg)
    group, artifact = _split_coordinate(package)
    results = []
    installable = []

    for idx, version in enumerate(versions, start=1):
        target = f"{group}:{artifact}:{version}"
        print(f"[{idx}/{len(versions)}] Attempting to resolve: {target}...")

        cmd = [
            "mvn",
            "dependency:get",
            f"-Dartifact={target}",
            f"-Dmaven.repo.local={repo_local}",
        ]
        if index_url:
            cmd.append(f"-DremoteRepositories=central::::{index_url}")
        cmd += options
        # Bump mvn's own verbosity if the user wants detail and nothing already set it.
        if verbose and not _has_verbose(options):
            cmd.append("-X")

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
                "error": _last_line(stderr_text) or _last_line(stdout_text) or "Unknown error",
            })

        # Persist after every iteration so partial results survive a crash.
        with open(output_json, "w") as f:
            json.dump(results, f, indent=4)

        if first_only and installable:
            print(f"  First resolvable version found: {installable[0]} (stopping).")
            break

    print(f"\nTesting complete! Results saved to {output_json}")
    if installable:
        print(f"Resolvable versions ({len(installable)}): {', '.join(installable)}")
    else:
        print("No resolvable versions found.")
    return results


def parse_args(argv=None):
    p = argparse.ArgumentParser(
        description="Find resolvable versions of an artifact from a Maven repository.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("package", help="Coordinate to probe as groupId:artifactId (e.g. com.google.guava:guava).")
    p.add_argument(
        "--repo-url",
        default=None,
        help="Custom Maven repository base URL. Defaults to $MAVEN_REPO_URL, "
             "then $JVM_REGISTRY_URL, then https://repo1.maven.org/maven2.",
    )
    p.add_argument(
        "--venv-dir",
        default=".m2-test-repo",
        help="Directory for the isolated local Maven repository.",
    )
    p.add_argument(
        "--maven-version",
        default=DEFAULT_MAVEN_VERSION,
        help="maven version to verify in the test environment ('none' to skip the check).",
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
        help="Stop after the first version that resolves successfully.",
    )
    p.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="Stream full mvn output for every step so failures are debuggable.",
    )
    return p.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)

    cfg = resolve_env()
    index_url = resolve_index_url(args.repo_url, cfg)

    versions = get_available_versions(args.package, index_url, cfg, verbose=args.verbose)
    if not versions:
        print("No versions found. Exiting.")
        return 1

    if args.limit is not None:
        versions = versions[: args.limit]

    print(f"Found {len(versions)} version(s) to test "
          f"(registry: {cfg['JVM_REGISTRY_NAME']}).")
    maven_version = None if str(args.maven_version).lower() == "none" else args.maven_version
    repo_local = setup_venv(args.venv_dir, maven_version, cfg, verbose=args.verbose)
    test_installations(
        repo_local,
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
# Example — probe the newest 5 versions of guava, stop at the first resolvable:
#     main(["com.google.guava:guava", "--repo-url", "https://repo1.maven.org/maven2",
#           "--limit", "5", "--first-only"])
#
# Equivalent on the command line:
#     python3 main.py com.google.guava:guava \
#         --repo-url https://repo1.maven.org/maven2 --limit 5 --first-only

if __name__ == "__main__":
    raise SystemExit(main())  # argv=None -> parse_args reads sys.argv
