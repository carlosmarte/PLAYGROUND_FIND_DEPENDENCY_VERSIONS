#!/usr/bin/env python3
"""Find installable versions of a package from a (custom) Arch pacman repository.

Discovers every version a repository advertises for a package via
``pacman -Si`` (current) plus the Arch Linux archive (historical), then attempts
to download each one into an isolated cache directory (``pacman -Sw --cachedir``),
recording success/failure per version to a JSON report.

Example:
    python main.py bash \
        --repository https://archive.archlinux.org

    # only probe the newest 5 versions, stop at the first that downloads
    python main.py bash --repository https://archive.archlinux.org \
        --limit 5 --first-only
"""

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

# pacman version the test environment is pinned to by default. Install-tests run
# against this pacman, so it governs resolver/cache behaviour. Override via
# --pacman-version (CLI) or the `pacman` command (REPL). pacman has no in-place
# "pin yourself to version X" command, so this constant is advisory: we record
# it, surface it, and warn if the host pacman differs.
DEFAULT_PACMAN_VERSION = "6.1.0"

# Base URL of the Arch Linux package archive (historical versions live here as
# downloadable package files; the current repo only advertises the latest).
ARCH_ARCHIVE_BASE = "https://archive.archlinux.org/packages"

# Environment knobs read via os.environ.get, each falling back to the value the
# Arch / pacman ecosystem uses by default ("industry standard"). pacman itself
# reads some of these from the environment; we resolve them explicitly so the
# documented default still applies when the var is unset, and so they can be
# surfaced (REPL `env`) and threaded into every pacman invocation we build.
ENV_DEFAULTS = {
    "PACMAN_VERBOSE": "0",                                # pacman: quiet (0 = no --debug)
    "PACMAN_CERT": "",                                    # pacman: use system CA store
    "PACMAN_INDEX": "https://archive.archlinux.org",      # pacman: archive base
    "PACMAN_REPOSITORY": "https://archive.archlinux.org", # pacman: repo / mirror base
    "PACMAN_TRUSTED_HOST": "",                            # pacman: no extra trusted hosts
    "PACMAN_DEFAULT_TIMEOUT": "15",                       # pacman: download timeout (s)
    "PACMAN_RETRIES": "5",                              # pacman: download retries
    "PACMAN_REGISTRY_URL": "https://archive.archlinux.org",  # our repo fallback
    "PACMAN_REGISTRY_NAME": "Arch",                      # registry display name
    "REQUESTS_CA_BUNDLE": "",                            # requests/urllib3: certifi
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
    """Pick the repo URL: explicit flag > PACMAN_REPOSITORY > PACMAN_REGISTRY_URL."""
    cfg = cfg or resolve_env()
    return explicit or cfg["PACMAN_REPOSITORY"] or cfg["PACMAN_REGISTRY_URL"] or None


def pacman_options(cfg):
    """Translate resolved config into pacman command-line flags."""
    opts = []
    try:
        level = int(cfg["PACMAN_VERBOSE"])
    except (TypeError, ValueError):
        level = 0
    if level > 0:
        opts.append("--debug")  # pacman's closest thing to -v (no -vv ladder)
    # pacman has no per-invocation timeout/retry flags the way pip does, but we
    # keep the same translation shape so the config surface mirrors the
    # reference even where pacman ignores a value.
    if cfg["PACMAN_TRUSTED_HOST"]:
        opts += ["--config", cfg["PACMAN_TRUSTED_HOST"]]
    return opts


def subprocess_env(cfg):
    """Child-process environment with resolved TLS cert vars applied."""
    env = os.environ.copy()
    for name in _TLS_ENV_VARS:
        if cfg[name]:
            env[name] = cfg[name]
    if cfg["PACMAN_CERT"]:
        env["PACMAN_CERT"] = cfg["PACMAN_CERT"]
    return env


def get_available_versions(package, index_url, cfg=None, verbose=False):
    """Return the list of versions a repository advertises for ``package``.

    Versions are returned newest-first. The current ``pacman -Si <pkg>`` only
    advertises the latest version, so historical versions are scraped from the
    Arch archive directory listing at ``<base>/packages/<first-letter>/<pkg>/``
    (stdlib ``urllib`` — no third-party deps), parsing the package-file links.
    The two sources are merged and sorted newest-first via ``vercmp``. When
    ``verbose`` is set, the commands/URLs and raw output are echoed so a failed
    or empty discovery can be debugged.
    """
    cfg = cfg or resolve_env()
    print(f"Retrieving versions for '{package}' from {index_url}...")
    versions = []

    # 1) Current version via `pacman -Si` (best-effort; may be unavailable).
    cmd = ["pacman", "-Si", package]
    cmd += pacman_options(cfg)
    if verbose:
        print(f"  $ {' '.join(cmd)}")
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, env=subprocess_env(cfg)
        )
        if verbose:
            _echo(result.stdout, result.stderr)
        m = re.search(r"^Version\s*:\s*(\S+)", result.stdout, re.MULTILINE)
        if m:
            versions.append(m.group(1))
    except FileNotFoundError:
        if verbose:
            print("  (pacman not on PATH; relying on the archive only)")

    # 2) Historical versions from the Arch archive directory listing.
    first = package[0].lower()
    listing_url = f"{ARCH_ARCHIVE_BASE}/{first}/{package}/"
    if verbose:
        print(f"  GET {listing_url}")
    try:
        req = urllib.request.Request(listing_url, headers={"User-Agent": "pacman-versions"})
        timeout = float(cfg["PACMAN_DEFAULT_TIMEOUT"])
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            html = resp.read().decode("utf-8", "replace")
        if verbose:
            _echo(html[:2000])
        # Archive files are named <pkg>-<version>-<arch>.pkg.tar.zst (skip the
        # .sig signatures). Capture the <version> between the package name and
        # the trailing -<arch>.pkg.tar.* suffix.
        pat = re.compile(
            re.escape(package)
            + r"-([^/\"]+?)-(?:x86_64|any|i686|aarch64)\.pkg\.tar\.[a-z]+(?:\")"
        )
        for v in pat.findall(html):
            if v not in versions:
                versions.append(v)
    except (urllib.error.URLError, ValueError, OSError) as e:
        if verbose:
            print(f"  (archive listing failed: {e})")

    if not versions:
        print("Could not find any versions from pacman or the Arch archive.", file=sys.stderr)
        return []
    # Dedupe preserving order, then sort newest-first via pacman's own vercmp.
    seen = []
    for v in versions:
        if v not in seen:
            seen.append(v)
    return _sort_versions_newest_first(seen, cfg)


def _sort_versions_newest_first(versions, cfg=None):
    """Sort pacman version strings newest-first using ``vercmp`` when available.

    pacman version ordering (epochs, ``pkgrel`` suffixes) is non-trivial, so we
    ask ``vercmp`` (ships with pacman) to compare pairs; if it is unavailable we
    fall back to a plain reverse string sort so discovery still degrades
    gracefully.
    """
    cfg = cfg or resolve_env()
    import functools

    def cmp(a, b):
        try:
            res = subprocess.run(
                ["vercmp", a, b],
                capture_output=True, text=True, env=subprocess_env(cfg),
            )
            token = res.stdout.strip()
            try:
                return int(token)  # vercmp prints -1 / 0 / 1
            except ValueError:
                return (a > b) - (a < b)
        except (FileNotFoundError, OSError):
            return (a > b) - (a < b)

    return sorted(versions, key=functools.cmp_to_key(cmp), reverse=True)


def setup_venv(env_dir, pacman_version=DEFAULT_PACMAN_VERSION, cfg=None, verbose=False):
    """Create a fresh isolated cache dir if needed; return its path.

    The "isolated test env" for pacman is a throwaway cache directory targeted
    via ``--cachedir <dir>`` — the analog of pip's venv. Download-tests write
    packages there so the host system stays untouched. ``pacman_version`` is
    advisory (pacman cannot re-pin itself in place): when set we verify the host
    pacman matches and ``verbose`` echoes the check. Pass ``pacman_version=None``
    to skip the check entirely.
    """
    cfg = cfg or resolve_env()
    if not os.path.exists(env_dir):
        print(f"Creating isolated pacman cache dir at: {env_dir}")
        os.makedirs(env_dir, exist_ok=True)

    # The "handle" the test step needs is the cache directory itself.
    cache_path = env_dir

    if pacman_version:
        _ensure_pacman_version(pacman_version, cfg, verbose=verbose)
    return cache_path


def _ensure_pacman_version(pacman_version, cfg=None, verbose=False):
    """Verify the host pacman matches ``pacman_version`` (advisory only)."""
    cfg = cfg or resolve_env()
    print(f"Ensuring pacman=={pacman_version} in the test environment...")
    cmd = ["pacman", "--version"]
    if verbose:
        print(f"  $ {' '.join(cmd)}")
    res = subprocess.run(cmd, capture_output=True, text=True, env=subprocess_env(cfg))
    if verbose:
        _echo(res.stdout, res.stderr)
    have = ""
    for line in (res.stdout or "").splitlines():
        m = re.search(r"Pacman v?(\S+)", line)
        if m:
            have = m.group(1)
            break
    if res.returncode != 0:
        print(
            f"Warning: could not query pacman version "
            f"(wanted {pacman_version}): {_last_line(res.stderr) or 'unknown error'}",
            file=sys.stderr,
        )
    elif have and pacman_version not in have:
        print(
            f"Warning: host pacman is '{have}', not {pacman_version} "
            f"(pacman cannot re-pin itself in place).",
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
    """True if pacman ``options`` already carry a ``--debug`` flag."""
    return any(o == "--debug" for o in options)


def _stream(cmd, env):
    """Run ``cmd``, echoing combined output live while capturing it.

    Returns ``(returncode, combined_output)``. Used in verbose mode so the user
    watches pacman in real time (e.g. a slow fetch or a hang) yet the captured
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


def test_installations(cache_path, package, index_url, versions, output_json,
                       first_only=False, cfg=None, verbose=False):
    """Attempt to download each version; write an incremental JSON report.

    Each version is downloaded into a *fresh* throwaway cache (so versions do
    not interfere with one another), via ``pacman -Sw --noconfirm --cachedir
    <tmp> <pkg>``. pacman's configured repos only carry the current version, so
    a specific historical version is resolved by handing pacman the archive URL
    of that exact package file when it is not the current one. Returns the list
    of result dicts. If ``first_only`` is set, stops after the first version
    that downloads successfully. When ``verbose`` is set, pacman's full output
    is streamed live (and a ``--debug`` flag is added if none is present) so
    failures can be debugged; the captured output is also folded into the report
    under ``log``/``error``.
    """
    cfg = cfg or resolve_env()
    env = subprocess_env(cfg)
    options = pacman_options(cfg)
    results = []
    installable = []
    first = package[0].lower()

    for idx, version in enumerate(versions, start=1):
        target = f"{package}={version}"
        print(f"[{idx}/{len(versions)}] Attempting to install: {target}...")

        # Per-version throwaway cache keeps downloads independent and crash-safe.
        tmp_cache = tempfile.mkdtemp(prefix="pacman-test-", dir=cache_path)
        # A specific version lives in the archive as a downloadable package file;
        # hand pacman that URL so it fetches exactly that version into the cache.
        archive_url = (
            f"{ARCH_ARCHIVE_BASE}/{first}/{package}/"
            f"{package}-{version}-x86_64.pkg.tar.zst"
        )
        cmd = [
            "pacman",
            "-Sw",
            "--noconfirm",
            "--cachedir",
            tmp_cache,
            archive_url,
        ]
        cmd += options
        # Bump pacman's own verbosity if the user wants detail and nothing already set it.
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
        description="Find installable versions of a package from an Arch pacman repository.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("package", help="Package name to probe (e.g. bash).")
    p.add_argument(
        "--repository",
        "--index-url",
        dest="index_url",
        default=None,
        help="Custom pacman repo/archive base URL. Defaults to $PACMAN_REPOSITORY, "
             "then $PACMAN_REGISTRY_URL, then the Arch archive.",
    )
    p.add_argument(
        "--venv-dir",
        default=".pacman-test-install",
        help="Directory for the isolated pacman cache(s).",
    )
    p.add_argument(
        "--pacman-version",
        default=DEFAULT_PACMAN_VERSION,
        help="pacman version to expect in the test env ('none' to skip the check).",
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
        help="Stream full pacman output for every step so failures are debuggable.",
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
          f"(registry: {cfg['PACMAN_REGISTRY_NAME']}).")
    pacman_version = None if str(args.pacman_version).lower() == "none" else args.pacman_version
    cache_path = setup_venv(args.venv_dir, pacman_version, cfg, verbose=args.verbose)
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
#     main(["bash", "--repository", "https://archive.archlinux.org",
#           "--limit", "5", "--first-only"])
#
# Equivalent on the command line:
#     python3 main.py bash \
#         --repository https://archive.archlinux.org --limit 5 --first-only

if __name__ == "__main__":
    raise SystemExit(main())  # argv=None -> parse_args reads sys.argv
