#!/usr/bin/env python3
"""Find installable versions of a package from a (custom) RPM/dnf repository.

Discovers every version a repository advertises for a package via
``dnf --showduplicates list``, then attempts to download each one into an
isolated download directory (``dnf install --downloadonly --downloaddir``),
recording success/failure per version to a JSON report.

Example:
    python main.py bash \
        --repository fedora

    # only probe the newest 5 versions, stop at the first that downloads
    python main.py bash --repository fedora \
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

# dnf version the test environment is pinned to by default. Install-tests run
# against this dnf, so it governs resolver/cache behaviour. Override via
# --dnf-version (CLI) or the `dnf` command (REPL). dnf has no in-place
# "pin yourself to version X" command, so this constant is advisory: we record
# it, surface it, and warn if the host dnf differs.
DEFAULT_DNF_VERSION = "4.21.1"

# Environment knobs read via os.environ.get, each falling back to the value the
# Fedora / dnf ecosystem uses by default ("industry standard"). dnf itself reads
# some of these from the environment; we resolve them explicitly so the
# documented default still applies when the var is unset, and so they can be
# surfaced (REPL `env`) and threaded into every dnf invocation we build.
ENV_DEFAULTS = {
    "DNF_VERBOSE": "0",                          # dnf: quiet (0 = no -v)
    "DNF_CERT": "",                              # dnf: use system CA store
    "DNF_INDEX": "fedora",                       # dnf: default repo id base
    "DNF_REPOSITORY": "fedora",                  # dnf: --repo id / config
    "DNF_TRUSTED_HOST": "",                      # dnf: no extra trusted hosts
    "DNF_DEFAULT_TIMEOUT": "15",                 # dnf: timeout (s)
    "DNF_RETRIES": "5",                         # dnf: retries
    "RPM_REGISTRY_URL": "fedora",                # our repo fallback (repo id)
    "RPM_REGISTRY_NAME": "Fedora",               # registry display name
    "REQUESTS_CA_BUNDLE": "",                    # requests/urllib3: certifi
    "SSL_CERT_FILE": "",                        # OpenSSL: system CA file
    "SSL_CERT_DIR": "",                         # OpenSSL: system CA dir
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
    """Pick the repo id: explicit flag > DNF_REPOSITORY > RPM_REGISTRY_URL."""
    cfg = cfg or resolve_env()
    return explicit or cfg["DNF_REPOSITORY"] or cfg["RPM_REGISTRY_URL"] or None


def dnf_options(cfg):
    """Translate resolved config into dnf command-line flags."""
    opts = []
    try:
        level = int(cfg["DNF_VERBOSE"])
    except (TypeError, ValueError):
        level = 0
    if level > 0:
        opts.append("-" + "v" * level)  # -v / -vv / -vvv ...
    # dnf reads timeouts/retries via --setopt; mirror the reference config
    # surface even where defaults already apply.
    opts += ["--setopt", f"timeout={cfg['DNF_DEFAULT_TIMEOUT']}"]
    opts += ["--setopt", f"retries={cfg['DNF_RETRIES']}"]
    return opts


def subprocess_env(cfg):
    """Child-process environment with resolved TLS cert vars applied."""
    env = os.environ.copy()
    for name in _TLS_ENV_VARS:
        if cfg[name]:
            env[name] = cfg[name]
    if cfg["DNF_CERT"]:
        env["DNF_CERT"] = cfg["DNF_CERT"]
    return env


def get_available_versions(package, index_url, cfg=None, verbose=False):
    """Return the list of versions a repository advertises for ``package``.

    Versions are returned newest-first. ``dnf --showduplicates list <pkg>``
    prints rows of ``name.arch  version-release  repo``; we collect the second
    column (``version-release``) and reverse so newest is first (dnf lists
    oldest-first). When ``verbose`` is set, the dnf command and its raw output
    are echoed so a failed or empty discovery can be debugged.
    """
    cfg = cfg or resolve_env()
    print(f"Retrieving versions for '{package}' from {index_url}...")
    cmd = [
        "dnf",
        "--showduplicates",
        "list",
        package,
    ]
    # Strip any -v/-vv from DNF_VERBOSE for this query: we only need the package
    # list rows, but verbose dnf emits a flood of metadata / cache lines — a
    # flood of output that bloats the captured buffer (and overflows the Node
    # twin's spawnSync limit). Keep the discovery query quiet.
    cmd += _strip_verbose(dnf_options(cfg))
    if index_url:
        cmd += ["--repo", index_url]
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
            f"Error running 'dnf list': {detail or 'unknown error'}",
            file=sys.stderr,
        )
        sys.exit(1)
    except FileNotFoundError:
        print("Error: 'dnf' not found on PATH (run inside Fedora/RHEL).", file=sys.stderr)
        sys.exit(1)

    if verbose:
        _echo(result.stdout)
    # `dnf --showduplicates list` rows look like:
    #   bash.x86_64    5.2.26-3.fc40    fedora
    # The version-release is the second whitespace column; the first must look
    # like name.arch (contains a dot) so we skip the "Available Packages:"
    # headers. dnf lists oldest-first, so reverse for newest-first.
    versions = []
    for line in result.stdout.splitlines():
        parts = line.split()
        if len(parts) >= 2 and "." in parts[0] and not line.endswith(":"):
            ver = parts[1]
            # version-release tokens carry a '-'; headers/notes won't.
            if "-" in ver and ver not in versions:
                versions.append(ver)
    if not versions:
        print("Could not find any versions in dnf list output.", file=sys.stderr)
        return []
    versions.reverse()  # dnf emits oldest-first; we want newest-first
    return versions


def setup_venv(env_dir, dnf_version=DEFAULT_DNF_VERSION, cfg=None, verbose=False):
    """Create a fresh isolated download dir if needed; return its path.

    The "isolated test env" for dnf is a throwaway download directory targeted
    via ``--downloaddir <dir>`` — the analog of pip's venv. Download-tests write
    RPMs there so the host system stays untouched. ``dnf_version`` is advisory
    (dnf cannot re-pin itself in place): when set we verify the host dnf matches
    and ``verbose`` echoes the check. Pass ``dnf_version=None`` to skip the
    check entirely.
    """
    cfg = cfg or resolve_env()
    if not os.path.exists(env_dir):
        print(f"Creating isolated dnf download dir at: {env_dir}")
        os.makedirs(env_dir, exist_ok=True)

    # The "handle" the test step needs is the download directory itself.
    download_path = env_dir

    if dnf_version:
        _ensure_dnf_version(dnf_version, cfg, verbose=verbose)
    return download_path


def _ensure_dnf_version(dnf_version, cfg=None, verbose=False):
    """Verify the host dnf matches ``dnf_version`` (advisory only)."""
    cfg = cfg or resolve_env()
    print(f"Ensuring dnf=={dnf_version} in the test environment...")
    cmd = ["dnf", "--version"]
    if verbose:
        print(f"  $ {' '.join(cmd)}")
    res = subprocess.run(cmd, capture_output=True, text=True, env=subprocess_env(cfg))
    if verbose:
        _echo(res.stdout, res.stderr)
    have = (res.stdout or "").splitlines()[0].strip() if res.stdout else ""
    if res.returncode != 0:
        print(
            f"Warning: could not query dnf version "
            f"(wanted {dnf_version}): {_last_line(res.stderr) or 'unknown error'}",
            file=sys.stderr,
        )
    elif dnf_version not in have:
        print(
            f"Warning: host dnf is '{have}', not {dnf_version} "
            f"(dnf cannot re-pin itself in place).",
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
    """True if dnf ``options`` already carry a ``-v``/``-vv`` flag."""
    return any(o.startswith("-v") for o in options)


def _strip_verbose(options):
    """Return ``options`` with any ``-v``/``-vv``/``-vvv`` verbosity flag removed."""
    return [o for o in options if not re.fullmatch(r"-v+", o)]


def _stream(cmd, env):
    """Run ``cmd``, echoing combined output live while capturing it.

    Returns ``(returncode, combined_output)``. Used in verbose mode so the user
    watches dnf in real time (e.g. a slow fetch or a hang) yet the captured text
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


def test_installations(download_path, package, index_url, versions, output_json,
                       first_only=False, cfg=None, verbose=False):
    """Attempt to download each version; write an incremental JSON report.

    Each version is downloaded into a *fresh* throwaway dir (so versions do not
    interfere with one another), via ``dnf install --downloadonly
    --downloaddir=<tmp> -y <pkg>-<ver>``. Returns the list of result dicts. If
    ``first_only`` is set, stops after the first version that downloads
    successfully. When ``verbose`` is set, dnf's full output is streamed live
    (and a ``-v`` flag is added if none is present) so failures can be
    debugged; the captured output is also folded into the report under
    ``log``/``error``.
    """
    cfg = cfg or resolve_env()
    env = subprocess_env(cfg)
    options = dnf_options(cfg)
    results = []
    installable = []

    for idx, version in enumerate(versions, start=1):
        target = f"{package}-{version}"
        print(f"[{idx}/{len(versions)}] Attempting to install: {target}...")

        # Per-version throwaway dir keeps downloads independent and crash-safe.
        tmp_dir = tempfile.mkdtemp(prefix="dnf-test-", dir=download_path)
        cmd = [
            "dnf",
            "install",
            "--downloadonly",
            f"--downloaddir={tmp_dir}",
            "-y",
            target,
        ]
        cmd += options
        if index_url:
            cmd += ["--repo", index_url]
        # Bump dnf's own verbosity if the user wants detail and nothing already set it.
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
        description="Find installable versions of a package from an RPM/dnf repository.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("package", help="Package name to probe (e.g. bash).")
    p.add_argument(
        "--repository",
        "--index-url",
        dest="index_url",
        default=None,
        help="dnf repo id to restrict to. Defaults to $DNF_REPOSITORY, "
             "then $RPM_REGISTRY_URL, then the configured repos.",
    )
    p.add_argument(
        "--venv-dir",
        default=".dnf-test-install",
        help="Directory for the isolated dnf download dir(s).",
    )
    p.add_argument(
        "--dnf-version",
        default=DEFAULT_DNF_VERSION,
        help="dnf version to expect in the test env ('none' to skip the check).",
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
        help="Stream full dnf output for every step so failures are debuggable.",
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
          f"(registry: {cfg['RPM_REGISTRY_NAME']}).")
    dnf_version = None if str(args.dnf_version).lower() == "none" else args.dnf_version
    download_path = setup_venv(args.venv_dir, dnf_version, cfg, verbose=args.verbose)
    test_installations(
        download_path,
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
#     main(["bash", "--repository", "fedora",
#           "--limit", "5", "--first-only"])
#
# Equivalent on the command line:
#     python3 main.py bash \
#         --repository fedora --limit 5 --first-only

if __name__ == "__main__":
    raise SystemExit(main())  # argv=None -> parse_args reads sys.argv
