#!/usr/bin/env python3
"""Find installable versions of a package from a (custom) CRAN registry.

Discovers every version a registry advertises for a package via the CRAN
database HTTP JSON API (``https://crandb.r-pkg.org/<pkg>/all``), then attempts
to install each one in an isolated R library directory, recording
success/failure per version to a JSON report.

Example:
    python main.py jsonlite \
        --repos https://cloud.r-project.org

    # only probe the newest 5 versions, stop at the first that installs
    python main.py jsonlite --repos https://cloud.r-project.org \
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

# R version the test environment is pinned to by default. Install-tests run
# against this R, so it governs resolver/build behaviour. Override via
# --r-version (CLI) or the `r` command (REPL). Note: R itself is provided by the
# host toolchain; we only record the pin we expect (remotes drives the install).
DEFAULT_R_VERSION = "4.4.2"

# Environment knobs read via os.environ.get, each falling back to the value the
# R / CRAN ecosystem uses by default ("industry standard"). R's install tooling
# (``remotes::install_version``) reads repository and TLS settings from the
# environment; we resolve them explicitly so the documented default still
# applies when the var is unset, and so they can be surfaced (REPL `env`) and
# threaded into every Rscript invocation we build.
ENV_DEFAULTS = {
    "R_VERBOSE": "0",                                # R: quiet (0 = no extra noise)
    "R_LIBS_USER": "",                               # R: extra user library path
    "CRAN_DB_URL": "https://crandb.r-pkg.org",       # crandb: version-listing API base
    "R_REPOS_URL": "https://cloud.r-project.org",    # R: PEP-style CRAN mirror (repos=)
    "R_DEFAULT_TIMEOUT": "60",                        # R: download.file.method timeout (s)
    "R_DOWNLOAD_RETRIES": "5",                        # remotes: download retries
    "R_REGISTRY_URL": "https://cloud.r-project.org",  # our repos fallback
    "R_REGISTRY_NAME": "CRAN",                       # registry display name
    "CURL_CA_BUNDLE": "",                            # curl/libcurl: CA bundle
    "SSL_CERT_FILE": "",                             # OpenSSL: system CA file
    "SSL_CERT_DIR": "",                              # OpenSSL: system CA dir
}

# TLS vars passed through to child processes via the environment (no CLI flag).
_TLS_ENV_VARS = ("CURL_CA_BUNDLE", "SSL_CERT_FILE", "SSL_CERT_DIR")


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
    """Pick the repos URL: explicit flag > R_REPOS_URL > R_REGISTRY_URL."""
    cfg = cfg or resolve_env()
    return explicit or cfg["R_REPOS_URL"] or cfg["R_REGISTRY_URL"] or None


def r_options(cfg):
    """Translate resolved config into Rscript/remotes option flags.

    R has no monolithic CLI flag surface like pip; we accumulate the knobs we
    honour (timeout, retries, verbosity) as a small list that ``test_installations``
    and ``get_available_versions`` weave into the R expression / request.
    """
    opts = []
    try:
        level = int(cfg["R_VERBOSE"])
    except (TypeError, ValueError):
        level = 0
    if level > 0:
        opts.append("--verbose")  # remotes honours options(verbose=TRUE) analog
    opts += ["--timeout", str(cfg["R_DEFAULT_TIMEOUT"])]
    opts += ["--retries", str(cfg["R_DOWNLOAD_RETRIES"])]
    return opts


def subprocess_env(cfg):
    """Child-process environment with resolved TLS cert vars applied."""
    env = os.environ.copy()
    for name in _TLS_ENV_VARS:
        if cfg[name]:
            env[name] = cfg[name]
    # Thread the download timeout through so libcurl-based fetches honour it.
    env["R_DEFAULT_INTERNET_TIMEOUT"] = str(cfg["R_DEFAULT_TIMEOUT"])
    return env


def get_available_versions(package, index_url, cfg=None, verbose=False):
    """Return the list of versions a registry advertises for ``package``.

    Versions are returned newest-first. CRAN has no native "list all versions"
    CLI, so we query the crandb HTTP JSON API (``<CRAN_DB_URL>/<pkg>/all``) via
    stdlib ``urllib``: the document carries a ``versions`` object whose keys are
    the live releases, plus an ``archived``/``timeline`` map covering versions
    pulled from the active index. We union both and sort newest-first. When
    ``verbose`` is set, the request URL and raw output are echoed so a failed or
    empty discovery can be debugged.
    """
    cfg = cfg or resolve_env()
    print(f"Retrieving versions for '{package}' from {index_url}...")
    db_url = cfg["CRAN_DB_URL"].rstrip("/")
    url = f"{db_url}/{package}/all"
    if verbose:
        print(f"  $ GET {url}")

    try:
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=int(cfg["R_DEFAULT_TIMEOUT"])) as resp:
            raw = resp.read().decode("utf-8")
    except Exception as e:  # urllib raises a family of errors; treat all as fatal
        print(f"Error querying crandb: {e}", file=sys.stderr)
        sys.exit(1)

    if verbose:
        _echo(raw)
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        print("Could not parse crandb JSON response.", file=sys.stderr)
        return []

    # Live versions live under ``versions`` (an object keyed by version string);
    # versions pulled from the active index live under ``timeline``/``archived``.
    seen = set()
    versions = list((data.get("versions") or {}).keys())
    for key in ("timeline", "archived"):
        block = data.get(key)
        if isinstance(block, dict):
            versions += list(block.keys())
    versions = [v for v in versions if not (v in seen or seen.add(v))]
    if not versions:
        print("Could not find any versions in crandb output.", file=sys.stderr)
        return []
    return sorted(versions, key=_version_key, reverse=True)  # newest-first


def _version_key(version):
    """Sort key splitting an R version (``1.2-3``/``1.2.3``) into int tuples."""
    return [int(p) if p.isdigit() else p for p in re.split(r"[.\-]", version)]


def setup_venv(env_dir, r_version=DEFAULT_R_VERSION, cfg=None, verbose=False):
    """Create a fresh isolated R library if needed; return its library path.

    Each install-test targets a throwaway R library directory (``.Library``)
    rather than the system library, so probes never mutate the host R install.
    The library is pinned conceptually to ``r_version`` (default
    ``DEFAULT_R_VERSION``) — the R toolchain itself is host-provided, so the pin
    is recorded/echoed rather than re-bootstrapped. Pass ``r_version=None`` to
    skip the pin announcement. ``verbose`` echoes the provisioning step so a
    failed setup can be debugged.
    """
    cfg = cfg or resolve_env()
    if not os.path.exists(env_dir):
        print(f"Creating isolated R library at: {env_dir}")
        os.makedirs(env_dir, exist_ok=True)

    lib_path = os.path.abspath(env_dir)  # remotes installs into this --lib

    if r_version:
        _ensure_r_version(lib_path, r_version, cfg, verbose=verbose)
    return lib_path


def _ensure_r_version(lib_path, r_version, cfg=None, verbose=False):
    """Record the R version the test library expects (host-provided toolchain)."""
    cfg = cfg or resolve_env()
    print(f"Ensuring R=={r_version} in the test environment...")
    cmd = ["Rscript", "-e", "cat(as.character(getRversion()))"]
    if verbose:
        print(f"  $ {' '.join(cmd)}")
    res = subprocess.run(cmd, capture_output=True, text=True, env=subprocess_env(cfg))
    if verbose:
        _echo(res.stdout, res.stderr)
    if res.returncode != 0:
        # A negative returncode means the child was killed by a signal, leaving
        # stderr empty — fall back to the signal name so the warning isn't blank.
        detail = _last_line(res.stderr) or _signal_detail(res.returncode) or "unknown error"
        print(
            f"Warning: could not confirm R=={r_version}: {detail}",
            file=sys.stderr,
        )


def _last_line(text):
    """Return the last non-empty line of ``text`` (for compact logging)."""
    lines = [ln for ln in (text or "").strip().splitlines() if ln.strip()]
    return lines[-1] if lines else ""


def _signal_detail(returncode):
    """Describe a signal-kill (negative ``returncode``) as ``terminated by signal <name>``.

    Returns an empty string when ``returncode`` is not a signal kill, so callers
    can chain it after their stderr-derived detail.
    """
    if returncode is None or returncode >= 0:
        return ""
    try:
        return f"terminated by signal {signal.Signals(-returncode).name}"
    except ValueError:
        return f"terminated by signal {-returncode}"


def _echo(*texts):
    """Write each non-empty text to stdout (newline-terminated). Verbose helper."""
    for t in texts:
        if t:
            sys.stdout.write(t if t.endswith("\n") else t + "\n")


def _has_verbose(options):
    """True if R ``options`` already carry a ``--verbose`` flag."""
    return any(o == "--verbose" for o in options)


def _stream(cmd, env):
    """Run ``cmd``, echoing combined output live while capturing it.

    Returns ``(returncode, combined_output)``. Used in verbose mode so the user
    watches the install in real time (e.g. a slow source build or a hang) yet
    the captured text still feeds the JSON report.
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


def test_installations(lib_path, package, index_url, versions, output_json,
                       first_only=False, cfg=None, verbose=False):
    """Attempt to install each version; write an incremental JSON report.

    Each version is installed via
    ``Rscript -e 'remotes::install_version("<pkg>", version="<ver>",
    repos="<repo>", lib="<tmp>")'`` into a throwaway temp library, success
    classified on returncode. Returns the list of result dicts. If ``first_only``
    is set, stops after the first version that installs successfully. When
    ``verbose`` is set, R's full output is streamed live (and ``--verbose`` is
    added if none is present) so install failures can be debugged; the captured
    output is also folded into the report under ``log``/``error``.
    """
    cfg = cfg or resolve_env()
    env = subprocess_env(cfg)
    options = r_options(cfg)
    repos = index_url or cfg["R_REGISTRY_URL"]
    results = []
    installable = []

    for idx, version in enumerate(versions, start=1):
        target = f"{package}=={version}"
        print(f"[{idx}/{len(versions)}] Attempting to install: {target}...")

        # A fresh temp library per version keeps installs hermetic and avoids
        # cross-version contamination of the shared --lib dir.
        tmp_lib = tempfile.mkdtemp(prefix="cran-itest-", dir=lib_path)
        want_verbose = "TRUE" if (verbose and not _has_verbose(options)) else "FALSE"
        expr = (
            f'options(timeout={cfg["R_DEFAULT_TIMEOUT"]}); '
            f'remotes::install_version("{package}", version="{version}", '
            f'repos="{repos}", lib="{tmp_lib}", upgrade="never", '
            f'quiet={"FALSE" if want_verbose == "TRUE" else "TRUE"})'
        )
        cmd = ["Rscript", "-e", expr]

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
            # A negative returncode means the child was killed by a signal,
            # leaving stderr empty — fall back to the signal name so the failure
            # isn't recorded blank.
            error = _last_line(stderr_text) or _signal_detail(returncode) or "Unknown error"
            results.append({
                "version": version,
                "status": "failed",
                "error": error,
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
        description="Find installable versions of a package from a CRAN registry.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("package", help="Package name to probe (e.g. jsonlite).")
    p.add_argument(
        "--repos",
        dest="index_url",
        default=None,
        help="Custom CRAN mirror (repos) URL. Defaults to $R_REPOS_URL, "
             "then $R_REGISTRY_URL, then https://cloud.r-project.org.",
    )
    p.add_argument(
        "--lib-dir",
        dest="venv_dir",
        default=".rlib-test-install",
        help="Directory for the isolated test R library.",
    )
    p.add_argument(
        "--r-version",
        default=DEFAULT_R_VERSION,
        help="R version to expect in the test library ('none' to skip the check).",
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
        help="Stream full R output for every step so failures are debuggable.",
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
          f"(registry: {cfg['R_REGISTRY_NAME']}).")
    r_version = None if str(args.r_version).lower() == "none" else args.r_version
    lib_path = setup_venv(args.venv_dir, r_version, cfg, verbose=args.verbose)
    test_installations(
        lib_path,
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
# Example — probe the newest 5 versions of jsonlite, stop at the first installable:
#     main(["jsonlite", "--repos", "https://cloud.r-project.org",
#           "--limit", "5", "--first-only"])
#
# Equivalent on the command line:
#     python3 main.py jsonlite \
#         --repos https://cloud.r-project.org --limit 5 --first-only

if __name__ == "__main__":
    raise SystemExit(main())  # argv=None -> parse_args reads sys.argv
