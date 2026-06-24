#!/usr/bin/env python3
"""Find resolvable versions of an artifact from Clojars (or a Maven repo).

Discovers every version Clojars advertises for a ``groupId:artifactId``
coordinate via the Clojars JSON API (falling back to ``maven-metadata.xml`` on
``repo.clojars.org``), then attempts to resolve each one into an isolated local
Maven repository via ``mvn dependency:get``, recording success/failure per
version to a JSON report.

Example:
    python main.py org.clojure:clojure \
        --repo-url https://repo.clojars.org

    # only probe the newest 5 versions, stop at the first that resolves
    python main.py org.clojure:clojure --repo-url https://repo.clojars.org \
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

# clojure/lein version the test environment is pinned to by default. Resolve-tests
# run against this toolchain, so it governs resolver/repository behaviour. Override
# via --clojure-version (CLI) or the `clojure` command (REPL).
DEFAULT_CLOJURE_VERSION = "1.12.0"

# Environment knobs read via os.environ.get, each falling back to the value the
# Clojure / JVM ecosystem uses by default ("industry standard"). The Maven-style
# resolver reads settings from the environment; we resolve them explicitly so the
# documented default still applies when the var is unset, and so they can be
# surfaced (REPL `env`) and threaded into every invocation we build.
ENV_DEFAULTS = {
    "CLOJARS_VERBOSE": "0",                            # mvn: quiet (0 = no -X)
    "CLOJARS_TRANSFER_TIMEOUT": "15",                  # mvn: 15s transfer timeout
    "CLOJARS_REPO_URL": "https://repo.clojars.org",    # mvn: remote repo base
    "MAVEN_OPTS": "",                                  # mvn: extra JVM opts
    "JVM_REGISTRY_URL": "https://repo.clojars.org",    # our repo-url fallback
    "JVM_REGISTRY_NAME": "Clojars",                    # registry display name
    "CLOJARS_API_URL": "https://clojars.org/api",      # clojars JSON API base
    "HTTPS_PROXY": "",                                 # http: optional proxy
    "HTTP_PROXY": "",                                  # http: optional proxy
    "NO_PROXY": "",                                    # http: proxy bypass list
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
    """Pick the repo URL: explicit flag > CLOJARS_REPO_URL > JVM_REGISTRY_URL."""
    cfg = cfg or resolve_env()
    return explicit or cfg["CLOJARS_REPO_URL"] or cfg["JVM_REGISTRY_URL"] or None


def clojars_options(cfg):
    """Translate resolved config into mvn command-line flags."""
    opts = []
    try:
        level = int(cfg["CLOJARS_VERBOSE"])
    except (TypeError, ValueError):
        level = 0
    if level > 0:
        opts.append("-X")  # maven debug output
    # Bound the remote transfer so a hung mirror fails fast rather than blocking.
    opts += ["-Dmaven.wagon.httpconnectionManager.ttlSeconds=" + str(cfg["CLOJARS_TRANSFER_TIMEOUT"])]
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
    """Split ``groupId:artifactId`` (or ``group/artifact``) into ``(group, artifact)``.

    Clojars commonly writes coordinates as ``group/artifact`` (Leiningen style);
    we accept either separator and normalise to a ``(group, artifact)`` pair.
    """
    sep = ":" if ":" in package else ("/" if "/" in package else None)
    if sep is None:
        print(
            f"Coordinate must be 'groupId:artifactId' or 'group/artifact' (got {package!r}).",
            file=sys.stderr,
        )
        sys.exit(1)
    group, artifact = package.split(sep, 1)
    return group.strip(), artifact.strip()


def _versions_from_api(group, artifact, cfg, verbose=False):
    """Fetch versions from the Clojars JSON API, newest-first; [] on any miss."""
    api = cfg["CLOJARS_API_URL"].rstrip("/")
    url = f"{api}/artifacts/{group}/{artifact}"
    if verbose:
        print(f"  $ GET {url}")
    try:
        with urllib.request.urlopen(url, timeout=int(cfg["CLOJARS_TRANSFER_TIMEOUT"])) as resp:
            data = json.loads(resp.read().decode("utf-8", "replace"))
    except Exception as e:  # noqa: BLE001 - API miss falls back to maven-metadata.xml
        if verbose:
            print(f"  (clojars API miss: {e})")
        return []
    # Prefer the explicit recent_versions list, else the flat versions list.
    recent = data.get("recent_versions") or []
    versions = [v.get("version") for v in recent if v.get("version")]
    if not versions:
        versions = [v for v in (data.get("versions") or []) if v]
    return versions


def _versions_from_metadata(group, artifact, base, cfg, verbose=False):
    """Fetch versions from ``maven-metadata.xml`` on the repo, newest-first."""
    group_path = group.replace(".", "/")
    url = f"{base.rstrip('/')}/{group_path}/{artifact}/maven-metadata.xml"
    if verbose:
        print(f"  $ GET {url}")
    try:
        with urllib.request.urlopen(url, timeout=int(cfg["CLOJARS_TRANSFER_TIMEOUT"])) as resp:
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
    versions = [el.text.strip() for el in root.iter("version") if el.text and el.text.strip()]
    # maven-metadata.xml lists oldest-first; reverse so newest leads (mirrors pip).
    return list(reversed(versions))


def get_available_versions(package, index_url, cfg=None, verbose=False):
    """Return the list of versions Clojars advertises for ``package``.

    Versions are returned newest-first. Discovery prefers the Clojars JSON API
    (``/api/artifacts/<group>/<artifact>``) and falls back to the artifact's
    ``maven-metadata.xml`` on ``repo.clojars.org`` when the API has nothing.
    When ``verbose`` is set, the URLs hit and their raw bodies are echoed so a
    failed or empty discovery can be debugged.
    """
    cfg = cfg or resolve_env()
    group, artifact = _split_coordinate(package)
    base = index_url or cfg["CLOJARS_REPO_URL"]
    print(f"Retrieving versions for '{package}' from {cfg['JVM_REGISTRY_NAME']}...")

    versions = _versions_from_api(group, artifact, cfg, verbose=verbose)
    if not versions:
        versions = _versions_from_metadata(group, artifact, base, cfg, verbose=verbose)
    if not versions:
        print("Could not find any versions via the Clojars API or maven-metadata.xml.",
              file=sys.stderr)
        return []
    return versions


def setup_venv(env_dir, clojure_version=DEFAULT_CLOJURE_VERSION, cfg=None, verbose=False):
    """Create a fresh isolated local Maven repository if needed; return its path.

    The sandbox is a throwaway directory used as ``-Dmaven.repo.local`` so every
    resolve-test fetches fresh into a known location, isolated from the host's
    ``~/.m2``. ``clojure_version`` is recorded for parity with the reference (the
    test step runs against whatever ``mvn``/``clojure`` is on PATH); pass
    ``clojure_version=None`` to skip the version check. ``verbose`` echoes the
    version output so a failed check can be debugged.
    """
    cfg = cfg or resolve_env()
    if not os.path.exists(env_dir):
        print(f"Creating local Maven repository at: {env_dir}")
        os.makedirs(env_dir, exist_ok=True)

    if clojure_version:
        _ensure_clojure_version(clojure_version, cfg, verbose=verbose)
    # The "handle" the test step needs is just the local-repo path.
    return env_dir


def _ensure_clojure_version(clojure_version, cfg=None, verbose=False):
    """Check the ``clojure`` (or ``mvn``) on PATH and warn if it can't be probed."""
    cfg = cfg or resolve_env()
    print(f"Ensuring clojure=={clojure_version} in the test environment...")
    cmd = ["clojure", "--version"]
    if verbose:
        print(f"  $ {' '.join(cmd)}")
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, env=subprocess_env(cfg))
    except FileNotFoundError:
        print(
            f"Warning: could not pin clojure=={clojure_version}: clojure not found on PATH",
            file=sys.stderr,
        )
        return
    if verbose:
        _echo(res.stdout, res.stderr)
    if res.returncode != 0:
        # A negative returncode means the child was killed by a signal, leaving
        # stderr/stdout empty — fall back to the signal name so it isn't blank.
        detail = _last_line(res.stderr) or _last_line(res.stdout)
        if not detail and res.returncode < 0:
            try:
                detail = f"terminated by signal {signal.Signals(-res.returncode).name}"
            except ValueError:
                detail = f"terminated by signal {-res.returncode}"
        print(
            f"Warning: could not pin clojure=={clojure_version}: "
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

    Each version is resolved via Maven-style ``mvn dependency:get`` pointed at
    the Clojars repository. Returns the list of result dicts. If ``first_only``
    is set, stops after the first version that resolves successfully. When
    ``verbose`` is set, mvn's full output is streamed live (and a ``-X`` flag is
    added if none is present) so resolution failures can be debugged; the
    captured output is also folded into the report under ``log``/``error``.
    """
    cfg = cfg or resolve_env()
    env = subprocess_env(cfg)
    options = clojars_options(cfg)
    group, artifact = _split_coordinate(package)
    repo = index_url or cfg["CLOJARS_REPO_URL"]
    results = []
    installable = []

    for idx, version in enumerate(versions, start=1):
        target = f"{group}:{artifact}:{version}"
        print(f"[{idx}/{len(versions)}] Attempting to resolve: {target}...")

        cmd = [
            "mvn",
            "dependency:get",
            f"-Dartifact={target}",
            f"-DremoteRepositories=clojars::::{repo}",
            f"-Dmaven.repo.local={repo_local}",
        ]
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
        description="Find resolvable versions of an artifact from Clojars.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("package", help="Coordinate to probe as groupId:artifactId or group/artifact (e.g. org.clojure:clojure).")
    p.add_argument(
        "--repo-url",
        default=None,
        help="Custom Maven repository base URL. Defaults to $CLOJARS_REPO_URL, "
             "then $JVM_REGISTRY_URL, then https://repo.clojars.org.",
    )
    p.add_argument(
        "--venv-dir",
        default=".m2-test-repo",
        help="Directory for the isolated local Maven repository.",
    )
    p.add_argument(
        "--clojure-version",
        default=DEFAULT_CLOJURE_VERSION,
        help="clojure/lein version to verify in the test environment ('none' to skip the check).",
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
    clojure_version = None if str(args.clojure_version).lower() == "none" else args.clojure_version
    repo_local = setup_venv(args.venv_dir, clojure_version, cfg, verbose=args.verbose)
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
# Example — probe the newest 5 versions of clojure, stop at the first resolvable:
#     main(["org.clojure:clojure", "--repo-url", "https://repo.clojars.org",
#           "--limit", "5", "--first-only"])
#
# Equivalent on the command line:
#     python3 main.py org.clojure:clojure \
#         --repo-url https://repo.clojars.org --limit 5 --first-only

if __name__ == "__main__":
    raise SystemExit(main())  # argv=None -> parse_args reads sys.argv
