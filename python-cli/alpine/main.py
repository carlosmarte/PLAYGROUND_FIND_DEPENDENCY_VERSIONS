#!/usr/bin/env python3
"""Find installable versions of a package from a (custom) Alpine apk repository.

Discovers every version a repository advertises for a package via
``apk policy``, then attempts to install each one into an isolated apk root
(``--root <tmp> --initdb``), recording success/failure per version to a JSON
report.

Example:
    python main.py busybox \
        --repository https://dl-cdn.alpinelinux.org/alpine/latest-stable/main

    # only probe the newest 5 versions, stop at the first that installs
    python main.py busybox --repository https://dl-cdn.alpinelinux.org/alpine/latest-stable/main \
        --limit 5 --first-only
"""

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile

# apk-tools version the test environment is pinned to by default. Install-tests
# run against this apk, so it governs index/signature behaviour. Override via
# --apk-version (CLI) or the `apk` command (REPL). apk-tools has no in-place
# "pin yourself to version X" command, so this constant is advisory: we record
# it, surface it, and warn if the host apk differs.
DEFAULT_APK_VERSION = "2.14.4"

# Environment knobs read via os.environ.get, each falling back to the value the
# Alpine / apk ecosystem uses by default ("industry standard"). apk itself reads
# some of these from the environment; we resolve them explicitly so the
# documented default still applies when the var is unset, and so they can be
# surfaced (REPL `env`) and threaded into every apk invocation we build.
ENV_DEFAULTS = {
    "APK_VERBOSE": "0",                                          # apk: quiet (0 = no -v)
    "APK_CERT": "",                                              # apk: use system CA store
    "APK_INDEX": "https://dl-cdn.alpinelinux.org/alpine",        # apk: mirror base
    "APK_REPOSITORY": "https://dl-cdn.alpinelinux.org/alpine/latest-stable/main",  # apk: repo URL
    "APK_TRUSTED_HOST": "",                                      # apk: no extra trusted hosts
    "APK_DEFAULT_TIMEOUT": "15",                                 # apk: 15s network timeout
    "APK_RETRIES": "5",                                          # apk: connection retries
    "ALPINE_REGISTRY_URL": "https://dl-cdn.alpinelinux.org/alpine/latest-stable/main",  # our repo fallback
    "ALPINE_REGISTRY_NAME": "Alpine",                           # registry display name
    "REQUESTS_CA_BUNDLE": "",                                    # requests/urllib3: certifi
    "SSL_CERT_FILE": "",                                         # OpenSSL: system CA file
    "SSL_CERT_DIR": "",                                          # OpenSSL: system CA dir
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
    """Pick the repo URL: explicit flag > APK_REPOSITORY > ALPINE_REGISTRY_URL."""
    cfg = cfg or resolve_env()
    return explicit or cfg["APK_REPOSITORY"] or cfg["ALPINE_REGISTRY_URL"] or None


def apk_options(cfg):
    """Translate resolved config into apk command-line flags."""
    opts = []
    try:
        level = int(cfg["APK_VERBOSE"])
    except (TypeError, ValueError):
        level = 0
    if level > 0:
        opts.append("-" + "v" * level)  # -v / -vv / -vvv ...
    # apk has no per-invocation cert/timeout flags the way pip does, but it does
    # honour these as repeated knobs; keep the same translation shape so the
    # config surface mirrors the reference even where apk ignores a value.
    if cfg["APK_TRUSTED_HOST"]:
        opts += ["--repository", cfg["APK_TRUSTED_HOST"]]
    return opts


def subprocess_env(cfg):
    """Child-process environment with resolved TLS cert vars applied."""
    env = os.environ.copy()
    for name in _TLS_ENV_VARS:
        if cfg[name]:
            env[name] = cfg[name]
    if cfg["APK_CERT"]:
        env["APK_CERT"] = cfg["APK_CERT"]
    return env


def get_available_versions(package, index_url, cfg=None, verbose=False):
    """Return the list of versions a repository advertises for ``package``.

    Versions are returned newest-first. ``apk policy <pkg>`` prints one block
    per configured repository, each listing the versions that repo offers; we
    collect the version tokens across all blocks, dedupe, and sort newest-first.
    When ``verbose`` is set, the apk command and its raw output are echoed so a
    failed or empty discovery can be debugged.
    """
    cfg = cfg or resolve_env()
    print(f"Retrieving versions for '{package}' from {index_url}...")
    cmd = [
        "apk",
        "policy",
        package,
    ]
    cmd += apk_options(cfg)
    if index_url:
        cmd += ["--repository", index_url]
    if verbose:
        print(f"  $ {' '.join(cmd)}")

    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, check=True, env=subprocess_env(cfg)
        )
    except subprocess.CalledProcessError as e:
        if verbose:
            _echo(e.stdout, e.stderr)
        print(f"Error running 'apk policy': {e.stderr.strip()}", file=sys.stderr)
        sys.exit(1)
    except FileNotFoundError:
        print("Error: 'apk' not found on PATH (run inside Alpine).", file=sys.stderr)
        sys.exit(1)

    if verbose:
        _echo(result.stdout)
    # `apk policy` output looks like:
    #   busybox policy:
    #     1.36.1-r5:
    #       https://dl-cdn.alpinelinux.org/alpine/latest-stable/main
    # Each indented `<version>:` line (no scheme, ends with ':') is a candidate.
    versions = []
    for line in result.stdout.splitlines():
        m = re.match(r"^\s+(\S+):\s*$", line)
        if m and "://" not in m.group(1):
            versions.append(m.group(1))
    if not versions:
        print("Could not find any versions in apk policy output.", file=sys.stderr)
        return []
    # Dedupe preserving order, then sort newest-first via apk's own comparison.
    seen = []
    for v in versions:
        if v not in seen:
            seen.append(v)
    return _sort_versions_newest_first(seen, cfg)


def _sort_versions_newest_first(versions, cfg=None):
    """Sort apk version strings newest-first using ``apk version -t`` when available.

    apk version ordering (suffixes like ``-r5``, ``_alpha``) is non-trivial, so
    we ask apk itself to compare pairs; if apk is unavailable we fall back to a
    plain reverse string sort so discovery still degrades gracefully.
    """
    cfg = cfg or resolve_env()
    import functools

    def cmp(a, b):
        try:
            res = subprocess.run(
                ["apk", "version", "-t", a, b],
                capture_output=True, text=True, env=subprocess_env(cfg),
            )
            token = res.stdout.strip()
            if token == "<":
                return -1
            if token == ">":
                return 1
            return 0
        except (FileNotFoundError, OSError):
            return (a > b) - (a < b)

    return sorted(versions, key=functools.cmp_to_key(cmp), reverse=True)


def setup_venv(env_dir, apk_version=DEFAULT_APK_VERSION, cfg=None, verbose=False):
    """Create a fresh isolated apk root if needed; return its root path.

    The "isolated test env" for apk is a throwaway root directory initialised
    with ``apk add --root <dir> --initdb`` — the analog of pip's venv. Install
    tests target this root so the host system stays untouched. ``apk_version``
    is advisory (apk-tools cannot re-pin itself in place): when set we verify
    the host apk matches and ``verbose`` echoes the check. Pass
    ``apk_version=None`` to skip the check entirely.
    """
    cfg = cfg or resolve_env()
    if not os.path.exists(env_dir):
        print(f"Creating isolated apk root at: {env_dir}")
        os.makedirs(env_dir, exist_ok=True)
        _initdb(env_dir, cfg, verbose=verbose)

    # The "handle" the test step needs is the root directory itself.
    root_path = env_dir

    if apk_version:
        _ensure_apk_version(apk_version, cfg, verbose=verbose)
    return root_path


def _initdb(root, cfg=None, verbose=False):
    """Initialise an empty apk database under ``root`` (idempotent best-effort)."""
    cfg = cfg or resolve_env()
    cmd = ["apk", "add", "--root", root, "--initdb", "--allow-untrusted"]
    if verbose:
        print(f"  $ {' '.join(cmd)}")
    res = subprocess.run(cmd, capture_output=True, text=True, env=subprocess_env(cfg))
    if verbose:
        _echo(res.stdout, res.stderr)
    if res.returncode != 0:
        print(
            f"Warning: could not initdb apk root at {root}: "
            f"{_last_line(res.stderr) or 'unknown error'}",
            file=sys.stderr,
        )


def _ensure_apk_version(apk_version, cfg=None, verbose=False):
    """Verify the host apk-tools matches ``apk_version`` (advisory only)."""
    cfg = cfg or resolve_env()
    print(f"Ensuring apk-tools=={apk_version} in the test environment...")
    cmd = ["apk", "--version"]
    if verbose:
        print(f"  $ {' '.join(cmd)}")
    res = subprocess.run(cmd, capture_output=True, text=True, env=subprocess_env(cfg))
    if verbose:
        _echo(res.stdout, res.stderr)
    have = _last_line(res.stdout)
    if res.returncode != 0:
        print(
            f"Warning: could not query apk-tools version "
            f"(wanted {apk_version}): {_last_line(res.stderr) or 'unknown error'}",
            file=sys.stderr,
        )
    elif apk_version not in have:
        print(
            f"Warning: host apk-tools is '{have}', not {apk_version} "
            f"(apk cannot re-pin itself in place).",
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
    """True if apk ``options`` already carry a ``-v``/``-vv`` flag."""
    return any(o.startswith("-v") for o in options)


def _stream(cmd, env):
    """Run ``cmd``, echoing combined output live while capturing it.

    Returns ``(returncode, combined_output)``. Used in verbose mode so the user
    watches apk in real time (e.g. a slow fetch or a hang) yet the captured text
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


def test_installations(root_path, package, index_url, versions, output_json,
                       first_only=False, cfg=None, verbose=False):
    """Attempt to install each version; write an incremental JSON report.

    Each version is installed into a *fresh* throwaway apk root (so versions do
    not interfere with one another), via ``apk add --root <tmp> --initdb
    --allow-untrusted <pkg>=<ver>``. Returns the list of result dicts. If
    ``first_only`` is set, stops after the first version that installs
    successfully. When ``verbose`` is set, apk's full output is streamed live
    (and a ``-v`` flag is added if none is present) so install failures can be
    debugged; the captured output is also folded into the report under
    ``log``/``error``.
    """
    cfg = cfg or resolve_env()
    env = subprocess_env(cfg)
    options = apk_options(cfg)
    results = []
    installable = []

    for idx, version in enumerate(versions, start=1):
        target = f"{package}={version}"
        print(f"[{idx}/{len(versions)}] Attempting to install: {target}...")

        # Per-version throwaway root keeps installs independent and crash-safe.
        tmp_root = tempfile.mkdtemp(prefix="apk-test-", dir=root_path)
        cmd = [
            "apk",
            "add",
            "--root",
            tmp_root,
            "--initdb",
            "--allow-untrusted",
            target,
        ]
        cmd += options
        if index_url:
            cmd += ["--repository", index_url]
        # Bump apk's own verbosity if the user wants detail and nothing already set it.
        if verbose and not _has_verbose(options):
            cmd.append("-v")

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
        description="Find installable versions of a package from an Alpine apk repository.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("package", help="Package name to probe (e.g. busybox).")
    p.add_argument(
        "--repository",
        "--index-url",
        dest="index_url",
        default=None,
        help="Custom apk repository URL. Defaults to $APK_REPOSITORY, "
             "then $ALPINE_REGISTRY_URL, then the Alpine latest-stable/main mirror.",
    )
    p.add_argument(
        "--venv-dir",
        default=".apk-test-install",
        help="Directory for the isolated apk test root(s).",
    )
    p.add_argument(
        "--apk-version",
        default=DEFAULT_APK_VERSION,
        help="apk-tools version to expect in the test env ('none' to skip the check).",
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
        help="Stream full apk output for every step so failures are debuggable.",
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
          f"(registry: {cfg['ALPINE_REGISTRY_NAME']}).")
    apk_version = None if str(args.apk_version).lower() == "none" else args.apk_version
    root_path = setup_venv(args.venv_dir, apk_version, cfg, verbose=args.verbose)
    test_installations(
        root_path,
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
# Example — probe the newest 5 versions of busybox, stop at the first installable:
#     main(["busybox", "--repository", "https://dl-cdn.alpinelinux.org/alpine/latest-stable/main",
#           "--limit", "5", "--first-only"])
#
# Equivalent on the command line:
#     python3 main.py busybox \
#         --repository https://dl-cdn.alpinelinux.org/alpine/latest-stable/main --limit 5 --first-only

if __name__ == "__main__":
    raise SystemExit(main())  # argv=None -> parse_args reads sys.argv
