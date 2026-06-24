#!/usr/bin/env python3
"""Find installable versions of a package from a (custom) Debian apt repository.

Discovers every version a repository advertises for a package via
``apt-cache madison``, then attempts to download each one into an isolated apt
cache directory (``apt-get install --download-only``), recording success/failure
per version to a JSON report.

Example:
    python main.py bash \
        --repository http://deb.debian.org/debian

    # only probe the newest 5 versions, stop at the first that downloads
    python main.py bash --repository http://deb.debian.org/debian \
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

# apt version the test environment is pinned to by default. Install-tests run
# against this apt, so it governs resolver/cache behaviour. Override via
# --apt-version (CLI) or the `apt` command (REPL). apt has no in-place
# "pin yourself to version X" command, so this constant is advisory: we record
# it, surface it, and warn if the host apt differs.
DEFAULT_APT_VERSION = "2.6.1"

# Environment knobs read via os.environ.get, each falling back to the value the
# Debian / apt ecosystem uses by default ("industry standard"). apt itself reads
# some of these from the environment; we resolve them explicitly so the
# documented default still applies when the var is unset, and so they can be
# surfaced (REPL `env`) and threaded into every apt invocation we build.
ENV_DEFAULTS = {
    "APT_VERBOSE": "0",                                # apt: quiet (0 = no -o Debug)
    "APT_CERT": "",                                    # apt: use system CA store
    "APT_INDEX": "http://deb.debian.org/debian",       # apt: mirror base
    "APT_REPOSITORY": "http://deb.debian.org/debian",  # apt: repo URL (sources.list)
    "APT_TRUSTED_HOST": "",                            # apt: no extra trusted hosts
    "APT_DEFAULT_TIMEOUT": "15",                       # apt: Acquire timeout (s)
    "APT_RETRIES": "5",                               # apt: Acquire retries
    "DEBIAN_REGISTRY_URL": "http://deb.debian.org/debian",  # our repo fallback
    "DEBIAN_REGISTRY_NAME": "Debian",                 # registry display name
    "REQUESTS_CA_BUNDLE": "",                          # requests/urllib3: certifi
    "SSL_CERT_FILE": "",                              # OpenSSL: system CA file
    "SSL_CERT_DIR": "",                               # OpenSSL: system CA dir
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
    """Pick the repo URL: explicit flag > APT_REPOSITORY > DEBIAN_REGISTRY_URL."""
    cfg = cfg or resolve_env()
    return explicit or cfg["APT_REPOSITORY"] or cfg["DEBIAN_REGISTRY_URL"] or None


def apt_options(cfg):
    """Translate resolved config into apt command-line flags."""
    opts = []
    try:
        level = int(cfg["APT_VERBOSE"])
    except (TypeError, ValueError):
        level = 0
    if level > 0:
        opts += ["-o", "Debug::pkgAcquire=true"]  # apt's closest thing to -v
    # apt reads timeouts/retries via -o Acquire::* options; mirror the reference
    # config surface even where defaults already apply.
    opts += ["-o", f"Acquire::http::Timeout={cfg['APT_DEFAULT_TIMEOUT']}"]
    opts += ["-o", f"Acquire::Retries={cfg['APT_RETRIES']}"]
    return opts


def subprocess_env(cfg):
    """Child-process environment with resolved TLS cert vars applied."""
    env = os.environ.copy()
    for name in _TLS_ENV_VARS:
        if cfg[name]:
            env[name] = cfg[name]
    if cfg["APT_CERT"]:
        env["APT_CERT"] = cfg["APT_CERT"]
    # apt-get is interactive-averse; force non-interactive in every child.
    env.setdefault("DEBIAN_FRONTEND", "noninteractive")
    return env


def get_available_versions(package, index_url, cfg=None, verbose=False):
    """Return the list of versions a repository advertises for ``package``.

    Versions are returned in the order ``apt-cache madison`` emits them (which
    is highest/preferred-first per apt's own ordering). Each madison row is
    ``name | version | repo``, pipe-separated; we take column 2. When ``verbose``
    is set, the apt command and its raw output are echoed so a failed or empty
    discovery can be debugged.
    """
    cfg = cfg or resolve_env()
    print(f"Retrieving versions for '{package}' from {index_url}...")
    cmd = [
        "apt-cache",
        "madison",
        package,
    ]
    # Strip apt's verbose toggle (`-o Debug::pkgAcquire=true`) for this query: we
    # only parse the pipe-separated madison rows, but Debug::pkgAcquire makes apt
    # emit a line per acquired URL — a flood of output that bloats the captured
    # buffer (and overflows the Node twin's spawnSync limit). Keep discovery quiet.
    cmd += _strip_debug(apt_options(cfg))
    if verbose:
        print(f"  $ {' '.join(cmd)}")

    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, check=True, env=subprocess_env(cfg)
        )
    except subprocess.CalledProcessError as e:
        if verbose:
            _echo(e.stdout, e.stderr)
        # A negative returncode means the child was killed by a signal, leaving
        # stderr empty — fall back to the signal name so the failure isn't blank.
        detail = (e.stderr or "").strip()
        if not detail and e.returncode is not None and e.returncode < 0:
            try:
                detail = f"terminated by signal {signal.Signals(-e.returncode).name}"
            except ValueError:
                detail = f"terminated by signal {-e.returncode}"
        print(
            f"Error running 'apt-cache madison': {detail or 'unknown error'}",
            file=sys.stderr,
        )
        sys.exit(1)
    except FileNotFoundError:
        print("Error: 'apt-cache' not found on PATH (run inside Debian/Ubuntu).", file=sys.stderr)
        sys.exit(1)

    if verbose:
        _echo(result.stdout)
    # madison rows look like:
    #   bash | 5.2.15-2+b2 | http://deb.debian.org/debian bookworm/main amd64 Packages
    # The version is the second pipe-separated column. Preserve madison's order.
    versions = []
    for line in result.stdout.splitlines():
        parts = [p.strip() for p in line.split("|")]
        if len(parts) >= 2 and parts[1]:
            if parts[1] not in versions:
                versions.append(parts[1])
    if not versions:
        print("Could not find any versions in apt-cache madison output.", file=sys.stderr)
        return []
    return versions


def setup_venv(env_dir, apt_version=DEFAULT_APT_VERSION, cfg=None, verbose=False):
    """Create a fresh isolated apt cache dir if needed; return its path.

    The "isolated test env" for apt is a throwaway cache directory targeted via
    ``-o Dir::Cache=<dir>`` — the analog of pip's venv. Download-tests write
    archives there so the host system stays untouched. ``apt_version`` is
    advisory (apt cannot re-pin itself in place): when set we verify the host
    apt matches and ``verbose`` echoes the check. Pass ``apt_version=None`` to
    skip the check entirely.
    """
    cfg = cfg or resolve_env()
    if not os.path.exists(env_dir):
        print(f"Creating isolated apt cache dir at: {env_dir}")
        os.makedirs(os.path.join(env_dir, "archives", "partial"), exist_ok=True)

    # The "handle" the test step needs is the cache directory itself.
    cache_path = env_dir

    if apt_version:
        _ensure_apt_version(apt_version, cfg, verbose=verbose)
    return cache_path


def _ensure_apt_version(apt_version, cfg=None, verbose=False):
    """Verify the host apt matches ``apt_version`` (advisory only)."""
    cfg = cfg or resolve_env()
    print(f"Ensuring apt=={apt_version} in the test environment...")
    cmd = ["apt-get", "--version"]
    if verbose:
        print(f"  $ {' '.join(cmd)}")
    res = subprocess.run(cmd, capture_output=True, text=True, env=subprocess_env(cfg))
    if verbose:
        _echo(res.stdout, res.stderr)
    have = (res.stdout or "").splitlines()[0] if res.stdout else ""
    if res.returncode != 0:
        print(
            f"Warning: could not query apt version "
            f"(wanted {apt_version}): {_last_line(res.stderr) or 'unknown error'}",
            file=sys.stderr,
        )
    elif apt_version not in have:
        print(
            f"Warning: host apt is '{have.strip()}', not {apt_version} "
            f"(apt cannot re-pin itself in place).",
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
    """True if apt ``options`` already carry a Debug ``-o`` flag."""
    return any("Debug" in o for o in options)


def _strip_debug(options):
    """Return ``options`` with the verbose Debug toggle removed.

    apt's verbosity is a two-token ``-o Debug::pkgAcquire=true`` pair (not
    ``-v``), so drop any ``Debug::*`` value AND the bare ``-o`` flag that
    introduces it, leaving the rest of the option list (timeouts, retries) intact.
    """
    out = []
    i = 0
    while i < len(options):
        if options[i] == "-o" and i + 1 < len(options) and "Debug" in options[i + 1]:
            i += 2  # skip both the "-o" and its "Debug::..." value
            continue
        if "Debug" in options[i]:  # stray Debug value with no -o
            i += 1
            continue
        out.append(options[i])
        i += 1
    return out


def _stream(cmd, env):
    """Run ``cmd``, echoing combined output live while capturing it.

    Returns ``(returncode, combined_output)``. Used in verbose mode so the user
    watches apt in real time (e.g. a slow fetch or a hang) yet the captured text
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


def test_installations(cache_path, package, index_url, versions, output_json,
                       first_only=False, cfg=None, verbose=False):
    """Attempt to download each version; write an incremental JSON report.

    Each version is downloaded into a *fresh* throwaway apt cache (so versions
    do not interfere with one another), via ``apt-get install --download-only -y
    -o Dir::Cache=<tmp> <pkg>=<ver>``. Returns the list of result dicts. If
    ``first_only`` is set, stops after the first version that downloads
    successfully. When ``verbose`` is set, apt's full output is streamed live
    (and a Debug ``-o`` is added if none is present) so failures can be
    debugged; the captured output is also folded into the report under
    ``log``/``error``.
    """
    cfg = cfg or resolve_env()
    env = subprocess_env(cfg)
    options = apt_options(cfg)
    results = []
    installable = []

    for idx, version in enumerate(versions, start=1):
        target = f"{package}={version}"
        print(f"[{idx}/{len(versions)}] Attempting to install: {target}...")

        # Per-version throwaway cache keeps downloads independent and crash-safe.
        tmp_cache = tempfile.mkdtemp(prefix="apt-test-", dir=cache_path)
        os.makedirs(os.path.join(tmp_cache, "archives", "partial"), exist_ok=True)
        cmd = [
            "apt-get",
            "install",
            "--download-only",
            "-y",
            "-o",
            f"Dir::Cache={tmp_cache}",
            target,
        ]
        cmd += options
        # Bump apt's own verbosity if the user wants detail and nothing already set it.
        if verbose and not _has_verbose(options):
            cmd += ["-o", "Debug::pkgAcquire=true"]

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
        description="Find installable versions of a package from a Debian apt repository.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("package", help="Package name to probe (e.g. bash).")
    p.add_argument(
        "--repository",
        "--index-url",
        dest="index_url",
        default=None,
        help="Custom apt repository URL. Defaults to $APT_REPOSITORY, "
             "then $DEBIAN_REGISTRY_URL, then the default Debian mirror.",
    )
    p.add_argument(
        "--venv-dir",
        default=".apt-test-install",
        help="Directory for the isolated apt cache(s).",
    )
    p.add_argument(
        "--apt-version",
        default=DEFAULT_APT_VERSION,
        help="apt version to expect in the test env ('none' to skip the check).",
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
        help="Stream full apt output for every step so failures are debuggable.",
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
          f"(registry: {cfg['DEBIAN_REGISTRY_NAME']}).")
    apt_version = None if str(args.apt_version).lower() == "none" else args.apt_version
    cache_path = setup_venv(args.venv_dir, apt_version, cfg, verbose=args.verbose)
    test_installations(
        cache_path,
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
# Example — probe the newest 5 versions of bash, stop at the first installable:
#     main(["bash", "--repository", "http://deb.debian.org/debian",
#           "--limit", "5", "--first-only"])
#
# Equivalent on the command line:
#     python3 main.py bash \
#         --repository http://deb.debian.org/debian --limit 5 --first-only

if __name__ == "__main__":
    raise SystemExit(main())  # argv=None -> parse_args reads sys.argv
