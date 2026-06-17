#!/usr/bin/env python3
"""Find installable versions of a Swift package from a git repository.

Swift Package Manager packages are plain git repositories whose releases are
semver tags. This tool discovers every tag a repo advertises via
``git ls-remote --tags``, then attempts to resolve each one in an isolated
throwaway package (a temp ``Package.swift`` pinning ``.exact("<ver>")``),
recording success/failure per version to a JSON report.

Example:
    python main.py https://github.com/apple/swift-argument-parser.git

    # only probe the newest 5 versions, stop at the first that resolves
    python main.py https://github.com/apple/swift-argument-parser.git \
        --limit 5 --first-only
"""

import argparse
import json
import os
import re
import subprocess
import sys

# swift version the test environment is pinned to by default. Resolve-tests run
# against this toolchain, so it governs resolver behaviour. Override via
# --swift-version (CLI) or the `swift` command (REPL). The swift toolchain is
# whatever is on PATH; this is informational (the OS/image selects it).
DEFAULT_SWIFT_VERSION = "6.0.3"

# Environment knobs read via os.environ.get, each falling back to the value the
# Swift / git / TLS ecosystem uses by default ("industry standard"). git/swift
# read several of these from the environment; we resolve them explicitly so the
# documented default still applies when the var is unset, and so they can be
# surfaced (REPL `env`) and threaded into every git/swift invocation we build.
ENV_DEFAULTS = {
    "SPM_VERBOSE": "0",                              # swift: quiet (0 = no -v)
    "GIT_TERMINAL_PROMPT": "0",                       # git: never prompt for creds
    "GIT_HTTP_LOW_SPEED_TIME": "30",                  # git: abort a stalled fetch
    "SWIFTPM_NETRC": "",                              # swift: optional .netrc path
    "SWIFT_REGISTRY_URL": "https://github.com",       # our repo-host fallback
    "SWIFT_REGISTRY_NAME": "git (Swift Package Manager)",  # registry display name
    "REQUESTS_CA_BUNDLE": "",                          # urllib/curl: certifi
    "SSL_CERT_FILE": "",                              # OpenSSL: system CA file
    "SSL_CERT_DIR": "",                              # OpenSSL: system CA dir
    "GIT_SSL_CAINFO": "",                            # git: explicit CA file
}

# TLS vars passed through to child processes via the environment (no CLI flag).
_TLS_ENV_VARS = ("REQUESTS_CA_BUNDLE", "SSL_CERT_FILE", "SSL_CERT_DIR", "GIT_SSL_CAINFO")


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
    """Pick the repo URL: explicit positional > SWIFT_REGISTRY_URL.

    For SPM the "registry" is the package's git repo URL itself, which is the
    positional package argument. There is no separate index to fall back to, so
    this exists mainly for symmetry with the reference's precedence chain.
    """
    cfg = cfg or resolve_env()
    return explicit or cfg["SWIFT_REGISTRY_URL"] or None


def git_options(cfg):
    """Translate resolved config into git/swift command-line flags."""
    opts = []
    try:
        level = int(cfg["SPM_VERBOSE"])
    except (TypeError, ValueError):
        level = 0
    if level > 0:
        opts.append("--verbose")  # swift package --verbose
    return opts


def subprocess_env(cfg):
    """Child-process environment with resolved TLS/git cfg applied."""
    env = os.environ.copy()
    for name in _TLS_ENV_VARS:
        if cfg[name]:
            env[name] = cfg[name]
    # Thread git's non-interactive/network knobs through so every git child obeys them.
    env["GIT_TERMINAL_PROMPT"] = str(cfg["GIT_TERMINAL_PROMPT"])
    if cfg["GIT_HTTP_LOW_SPEED_TIME"]:
        env["GIT_HTTP_LOW_SPEED_TIME"] = str(cfg["GIT_HTTP_LOW_SPEED_TIME"])
    if cfg["SWIFTPM_NETRC"]:
        env["SWIFTPM_NETRC"] = cfg["SWIFTPM_NETRC"]
    return env


def get_available_versions(package, index_url, cfg=None, verbose=False):
    """Return the list of versions a repo advertises for ``package``.

    For SPM the ``package`` is itself the git repo URL. We list tags via
    ``git ls-remote --tags``, strip the ``^{}`` peeled-tag suffix, keep only
    semver-looking tags, and sort newest-first to match ``pip``'s contract. When
    ``verbose`` is set, the git command and its raw output are echoed so a failed
    or empty discovery can be debugged.
    """
    cfg = cfg or resolve_env()
    repo_url = package  # the package IS the git repo URL for SPM
    print(f"Retrieving versions for '{package}' from {repo_url}...")
    cmd = [
        "git",
        "ls-remote",
        "--tags",
        repo_url,
    ]
    cmd += git_options(cfg)
    if verbose:
        print(f"  $ {' '.join(cmd)}")

    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, check=True, env=subprocess_env(cfg)
        )
    except subprocess.CalledProcessError as e:
        if verbose:
            _echo(e.stdout, e.stderr)
        print(f"Error running 'git ls-remote --tags': {e.stderr.strip()}", file=sys.stderr)
        sys.exit(1)

    if verbose:
        _echo(result.stdout)
    return _parse_semver_tags(result.stdout)


def _parse_semver_tags(text):
    """Parse ``git ls-remote --tags`` output into semver versions, newest-first.

    Each line looks like ``<sha>\trefs/tags/<tag>`` (with a ``^{}`` suffix on the
    peeled annotated-tag line). We drop the ``^{}`` lines, strip an optional
    leading ``v``, keep only tags that look like semver, and sort descending.
    """
    versions = set()
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        ref = line.split("\t")[-1]
        if not ref.startswith("refs/tags/"):
            continue
        tag = ref[len("refs/tags/"):]
        if tag.endswith("^{}"):
            tag = tag[: -len("^{}")]  # peeled annotated tag — dedupe via the set
        candidate = tag[1:] if tag.lower().startswith("v") else tag
        if re.fullmatch(r"\d+\.\d+(\.\d+)?([-+][0-9A-Za-z.-]+)?", candidate):
            versions.add(candidate)
    if not versions:
        print("Could not find any semver tags in 'git ls-remote' output.", file=sys.stderr)
        return []
    return sorted(versions, key=_semver_key, reverse=True)  # newest-first


def _semver_key(version):
    """Sort key: (major, minor, patch, release-rank) — release > pre-release."""
    core = re.split(r"[-+]", version, maxsplit=1)[0]
    parts = [int(p) for p in core.split(".")] + [0, 0, 0]
    # A pre-release (e.g. 1.0.0-beta) sorts below its release; rank 1 > 0.
    rank = 0 if re.search(r"[-]", version) else 1
    return (parts[0], parts[1], parts[2], rank)


def setup_venv(env_dir, swift_version=DEFAULT_SWIFT_VERSION, cfg=None, verbose=False):
    """Create a fresh throwaway package dir if needed; return its directory path.

    The sandbox is a temp package directory into which a per-version
    ``Package.swift`` is written and resolved. The active toolchain is reported
    as ``swift_version`` (default ``DEFAULT_SWIFT_VERSION``) so resolve-tests run
    against a known swift. Pass ``swift_version=None`` to keep whatever swift is
    on PATH. ``verbose`` echoes the scaffold output so a failed setup can be
    debugged.
    """
    cfg = cfg or resolve_env()
    if not os.path.exists(env_dir):
        print(f"Creating throwaway package dir at: {env_dir}")
        os.makedirs(env_dir, exist_ok=True)
        # Minimal Sources tree so `swift package resolve` has a valid target.
        src = os.path.join(env_dir, "Sources", "verprobe")
        os.makedirs(src, exist_ok=True)
        with open(os.path.join(src, "main.swift"), "w") as f:
            f.write('print("verprobe")\n')

    if swift_version:
        _ensure_pip_version(env_dir, swift_version, cfg, verbose=verbose)
    return env_dir


def _ensure_pip_version(env_dir, swift_version, cfg=None, verbose=False):
    """Report the active swift toolchain (PATH, not the package dir, owns it)."""
    cfg = cfg or resolve_env()
    print(f"Ensuring swift=={swift_version} in the test environment...")
    cmd = ["swift", "--version"]
    if verbose:
        print(f"  $ {' '.join(cmd)}")
    res = subprocess.run(cmd, capture_output=True, text=True, env=subprocess_env(cfg))
    if verbose:
        _echo(res.stdout, res.stderr)
    if res.returncode != 0:
        print(
            f"Warning: could not confirm swift=={swift_version}: "
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
    """True if ``options`` already carry a ``--verbose``/``-v`` flag."""
    return any(o.startswith("--verbose") or o == "-v" for o in options)


def _stream(cmd, env, cwd=None):
    """Run ``cmd``, echoing combined output live while capturing it.

    Returns ``(returncode, combined_output)``. Used in verbose mode so the user
    watches swift in real time (e.g. a slow clone or a hang) yet the captured
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


_PACKAGE_SWIFT_TEMPLATE = '''// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "verprobe",
    dependencies: [
        .package(url: "{repo_url}", exact: "{version}"),
    ],
    targets: [
        .executableTarget(name: "verprobe"),
    ]
)
'''


def _write_package_swift(env_dir, repo_url, version):
    """Write a per-version Package.swift pinning ``.exact("<version>")``."""
    manifest = _PACKAGE_SWIFT_TEMPLATE.format(repo_url=repo_url, version=version)
    with open(os.path.join(env_dir, "Package.swift"), "w") as f:
        f.write(manifest)


def test_installations(pip_path, package, index_url, versions, output_json,
                       first_only=False, cfg=None, verbose=False):
    """Attempt to resolve each version; write an incremental JSON report.

    ``pip_path`` is the throwaway package directory from ``setup_venv``;
    ``package`` is the git repo URL. For each version we rewrite Package.swift to
    pin ``.exact("<ver>")`` then run ``swift package resolve``. Returns the list
    of result dicts. If ``first_only`` is set, stops after the first version that
    resolves successfully. When ``verbose`` is set, swift's full output is
    streamed live (and a ``--verbose`` flag is added if none is present) so
    resolve failures can be debugged; the captured output is also folded into
    the report under ``log``/``error``.
    """
    cfg = cfg or resolve_env()
    env = subprocess_env(cfg)
    options = git_options(cfg)
    repo_url = package  # the package IS the git repo URL for SPM
    results = []
    installable = []

    for idx, version in enumerate(versions, start=1):
        target = f"{repo_url}@{version}"
        print(f"[{idx}/{len(versions)}] Attempting to resolve: {target}...")

        # Rewrite the manifest each iteration to pin exactly this version, and
        # drop any stale lock so the resolver re-evaluates from scratch.
        _write_package_swift(pip_path, repo_url, version)
        lock = os.path.join(pip_path, "Package.resolved")
        if os.path.exists(lock):
            os.remove(lock)

        cmd = [
            "swift",
            "package",
            "resolve",
        ]
        cmd += options
        # Bump swift's verbosity if the user wants detail and nothing already set it.
        if verbose and not _has_verbose(options):
            cmd.append("--verbose")

        if verbose:
            print(f"  $ (cd {pip_path} && {' '.join(cmd)})")
            returncode, output = _stream(cmd, env, cwd=pip_path)
            stdout_text = stderr_text = output  # streamed combined; same text both ways
        else:
            res = subprocess.run(cmd, capture_output=True, text=True, env=env, cwd=pip_path)
            returncode, stdout_text, stderr_text = res.returncode, res.stdout, res.stderr

        if returncode == 0:
            print(f"  ✅ SUCCESS: {target}")
            results.append({
                "version": version,
                "status": "success",
                "log": _last_line(stdout_text) or _last_line(stderr_text),
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
        description="Find installable versions of a Swift package from a git repo.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument(
        "package",
        help="Swift package git repo URL to probe "
             "(e.g. https://github.com/apple/swift-argument-parser.git).",
    )
    p.add_argument(
        "--registry",
        dest="index_url",
        default=None,
        help="Repo host (informational; the package URL is the real source). "
             "Defaults to $SWIFT_REGISTRY_URL, then https://github.com.",
    )
    p.add_argument(
        "--venv-dir",
        default=".venv-test-install",
        help="Directory for the isolated throwaway test package.",
    )
    p.add_argument(
        "--swift-version",
        default=DEFAULT_SWIFT_VERSION,
        help="swift version to assert in the test package ('none' to keep the active toolchain).",
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
        help="Stream full swift output for every step so failures are debuggable.",
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
          f"(registry: {cfg['SWIFT_REGISTRY_NAME']}).")
    swift_version = None if str(args.swift_version).lower() == "none" else args.swift_version
    pip_path = setup_venv(args.venv_dir, swift_version, cfg, verbose=args.verbose)
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
# Example — probe the newest 5 versions of a package, stop at the first installable:
#     main(["https://github.com/apple/swift-argument-parser.git",
#           "--limit", "5", "--first-only"])
#
# Equivalent on the command line:
#     python3 main.py https://github.com/apple/swift-argument-parser.git \
#         --limit 5 --first-only

if __name__ == "__main__":
    raise SystemExit(main())  # argv=None -> parse_args reads sys.argv
