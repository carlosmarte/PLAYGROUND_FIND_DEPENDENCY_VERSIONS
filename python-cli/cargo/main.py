#!/usr/bin/env python3
"""Find installable versions of a crate from a (custom) Cargo registry.

Discovers every version a registry advertises for a crate via the crates.io
JSON API (``https://crates.io/api/v1/crates/<crate>``), then attempts to fetch
each one into an isolated throwaway crate, recording success/failure per version
to a JSON report.

Example:
    python main.py serde \
        --registry https://my-registry.example.com

    # only probe the newest 5 versions, stop at the first that fetches
    python main.py serde --registry https://reg \
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

# cargo/rust version the test environment is pinned to by default. Fetch-tests
# run against this toolchain, so it governs resolver/cooldown behaviour. Override
# via --cargo-version (CLI) or the `cargo` command (REPL). Cargo ships with the
# Rust toolchain, so this is informational (rustup selects the active toolchain).
DEFAULT_CARGO_VERSION = "1.83.0"

# Environment knobs read via os.environ.get, each falling back to the value the
# Rust / Cargo / TLS ecosystem uses by default ("industry standard"). cargo
# itself auto-reads CARGO_* vars from the environment; we resolve them explicitly
# so the documented default still applies when the var is unset, and so they can
# be surfaced (REPL `env`) and threaded into every cargo invocation we build.
ENV_DEFAULTS = {
    "CARGO_TERM_VERBOSE": "false",                   # cargo: quiet (no --verbose)
    "CARGO_NET_RETRY": "3",                           # cargo: 3 network retries
    "CARGO_HTTP_TIMEOUT": "30",                       # cargo: 30s HTTP timeout
    "CARGO_HTTP_CAINFO": "",                          # cargo: use system CA store
    "CARGO_REGISTRIES_CRATES_IO_PROTOCOL": "sparse",  # cargo: sparse index protocol
    "CARGO_API_URL": "https://crates.io/api/v1/crates",  # our version-list API base
    "RUST_REGISTRY_URL": "https://crates.io",         # our registry fallback
    "RUST_REGISTRY_NAME": "crates.io",                # registry display name
    "SSL_CERT_FILE": "",                              # OpenSSL: system CA file
    "SSL_CERT_DIR": "",                               # OpenSSL: system CA dir
    "HTTPS_PROXY": "",                                # libcurl/cargo: HTTPS proxy
}

# TLS/proxy vars passed through to child processes via the environment (no CLI flag).
_TLS_ENV_VARS = ("SSL_CERT_FILE", "SSL_CERT_DIR", "HTTPS_PROXY")


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
    """Pick the registry URL: explicit flag > CARGO_REGISTRIES_CRATES_IO > RUST_REGISTRY_URL."""
    cfg = cfg or resolve_env()
    return (
        explicit
        or os.environ.get("CARGO_REGISTRIES_CRATES_IO_INDEX")
        or cfg["RUST_REGISTRY_URL"]
        or None
    )


def cargo_options(cfg):
    """Translate resolved config into cargo command-line flags."""
    opts = []
    if str(cfg["CARGO_TERM_VERBOSE"]).lower() in ("1", "true", "yes"):
        opts.append("--verbose")  # cargo --verbose
    # cargo reads net retry/timeout from the environment (threaded via
    # subprocess_env), so there are no direct CLI equivalents to add here.
    return opts


def subprocess_env(cfg):
    """Child-process environment with resolved TLS/network cfg applied."""
    env = os.environ.copy()
    for name in _TLS_ENV_VARS:
        if cfg[name]:
            env[name] = cfg[name]
    # Thread cargo's network knobs through so every cargo child obeys them.
    env["CARGO_NET_RETRY"] = str(cfg["CARGO_NET_RETRY"])
    env["CARGO_HTTP_TIMEOUT"] = str(cfg["CARGO_HTTP_TIMEOUT"])
    if cfg["CARGO_HTTP_CAINFO"]:
        env["CARGO_HTTP_CAINFO"] = cfg["CARGO_HTTP_CAINFO"]
    return env


def get_available_versions(package, index_url, cfg=None, verbose=False):
    """Return the list of versions a registry advertises for ``package``.

    Versions are returned newest-first, mirroring the order the crates.io API
    serves them (``versions[].num``, already newest-first). When ``verbose`` is
    set, the API URL and its raw output are echoed so a failed or empty discovery
    can be debugged. crates.io has no robust "list versions" subcommand, so we go
    straight to its JSON API over stdlib ``urllib``.
    """
    cfg = cfg or resolve_env()
    print(f"Retrieving versions for '{package}' from {index_url}...")
    api_base = cfg["CARGO_API_URL"].rstrip("/")
    url = f"{api_base}/{package}"
    if verbose:
        print(f"  $ GET {url}")

    req = urllib.request.Request(url, headers={"User-Agent": "cargo-versions/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=int(cfg["CARGO_HTTP_TIMEOUT"])) as resp:
            raw = resp.read().decode("utf-8")
    except Exception as e:  # urllib.error.URLError, HTTPError, socket timeout, ...
        if verbose:
            _echo(str(e))
        print(f"Error querying crates.io API: {e}", file=sys.stderr)
        sys.exit(1)

    if verbose:
        _echo(raw)
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        print("Could not parse JSON from the crates.io API.", file=sys.stderr)
        return []
    versions = [v.get("num") for v in data.get("versions", []) if v.get("num")]
    if not versions:
        print("Could not find any 'versions[].num' in the API response.", file=sys.stderr)
        return []
    return versions  # crates.io already serves these newest-first


def setup_venv(env_dir, cargo_version=DEFAULT_CARGO_VERSION, cfg=None, verbose=False):
    """Create a fresh throwaway crate if needed; return its directory path.

    The sandbox is a temp crate (``cargo init``) into which each candidate
    version is added and fetched. The active toolchain is reported as
    ``cargo_version`` (default ``DEFAULT_CARGO_VERSION``) so fetch-tests run
    against a known cargo. Pass ``cargo_version=None`` to keep whatever toolchain
    rustup selects. ``verbose`` echoes the init output so a failed scaffold can
    be debugged.
    """
    cfg = cfg or resolve_env()
    if not os.path.exists(os.path.join(env_dir, "Cargo.toml")):
        print(f"Creating throwaway crate at: {env_dir}")
        os.makedirs(env_dir, exist_ok=True)
        init = subprocess.run(
            ["cargo", "init", "--name", "verprobe", "--vcs", "none", env_dir],
            capture_output=True, text=True, env=subprocess_env(cfg),
        )
        if verbose:
            _echo(init.stdout, init.stderr)
        if init.returncode != 0:
            print(
                f"Warning: could not init throwaway crate: "
                f"{_last_line(init.stderr) or 'unknown error'}",
                file=sys.stderr,
            )

    if cargo_version:
        _ensure_pip_version(env_dir, cargo_version, cfg, verbose=verbose)
    return env_dir


def _ensure_pip_version(env_dir, cargo_version, cfg=None, verbose=False):
    """Report the active cargo toolchain (rustup, not the crate dir, owns it)."""
    cfg = cfg or resolve_env()
    print(f"Ensuring cargo=={cargo_version} in the test environment...")
    cmd = ["cargo", "--version"]
    if verbose:
        print(f"  $ {' '.join(cmd)}")
    res = subprocess.run(cmd, capture_output=True, text=True, env=subprocess_env(cfg))
    if verbose:
        _echo(res.stdout, res.stderr)
    if res.returncode != 0:
        # A negative returncode means the child was killed by a signal, leaving
        # stderr empty — fall back to the signal name so the warning isn't blank.
        detail = _last_line(res.stderr)
        if not detail and res.returncode is not None and res.returncode < 0:
            try:
                detail = f"terminated by signal {signal.Signals(-res.returncode).name}"
            except ValueError:
                detail = f"terminated by signal {-res.returncode}"
        print(
            f"Warning: could not confirm cargo=={cargo_version}: "
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
    """True if cargo ``options`` already carry a ``--verbose`` flag."""
    return any(o.startswith("--verbose") or o == "-v" for o in options)


def _stream(cmd, env, cwd=None):
    """Run ``cmd``, echoing combined output live while capturing it.

    Returns ``(returncode, combined_output)``. Used in verbose mode so the user
    watches cargo in real time (e.g. a slow build or a hang) yet the captured
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


def test_installations(pip_path, package, index_url, versions, output_json,
                       first_only=False, cfg=None, verbose=False):
    """Attempt to fetch each version; write an incremental JSON report.

    ``pip_path`` is the throwaway crate directory from ``setup_venv``. Returns
    the list of result dicts. If ``first_only`` is set, stops after the first
    version that fetches successfully. When ``verbose`` is set, cargo's full
    output is streamed live (and a ``--verbose`` flag is added if none is
    present) so fetch failures can be debugged; the captured output is also
    folded into the report under ``log``/``error``.
    """
    cfg = cfg or resolve_env()
    env = subprocess_env(cfg)
    options = cargo_options(cfg)
    results = []
    installable = []

    for idx, version in enumerate(versions, start=1):
        target = f"{package}@{version}"
        print(f"[{idx}/{len(versions)}] Attempting to fetch: {target}...")

        # `cargo add` pins the dependency, `cargo fetch` downloads it — together
        # they prove the registry actually serves this version. Re-add each time
        # (cargo overwrites the prior pin in Cargo.toml).
        add_cmd = ["cargo", "add", target]
        add_cmd += options
        if index_url and "crates.io" not in index_url:
            add_cmd += ["--registry", _registry_name(index_url)]
        fetch_cmd = ["cargo", "fetch"] + options
        # Bump cargo's verbosity if the user wants detail and nothing already set it.
        if verbose and not _has_verbose(options):
            add_cmd.append("--verbose")
            fetch_cmd.append("--verbose")

        if verbose:
            print(f"  $ (cd {pip_path} && {' '.join(add_cmd)} && {' '.join(fetch_cmd)})")
            returncode, output = _stream(add_cmd, env, cwd=pip_path)
            if returncode == 0:
                rc2, out2 = _stream(fetch_cmd, env, cwd=pip_path)
                returncode, output = rc2, output + out2
            stdout_text = stderr_text = output  # streamed combined; same text both ways
        else:
            res = subprocess.run(add_cmd, capture_output=True, text=True, env=env, cwd=pip_path)
            if res.returncode == 0:
                res = subprocess.run(
                    fetch_cmd, capture_output=True, text=True, env=env, cwd=pip_path
                )
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


def _registry_name(index_url):
    """Derive a cargo --registry alias from a registry URL (host-ish slug)."""
    slug = re.sub(r"^https?://", "", index_url or "").strip("/")
    slug = re.sub(r"[^A-Za-z0-9]+", "-", slug).strip("-")
    return slug or "custom"


def parse_args(argv=None):
    p = argparse.ArgumentParser(
        description="Find installable versions of a crate from a Cargo registry.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("package", help="Crate name to probe (e.g. serde).")
    p.add_argument(
        "--registry",
        dest="index_url",
        default=None,
        help="Custom Cargo registry URL. Defaults to "
             "$CARGO_REGISTRIES_CRATES_IO_INDEX, then $RUST_REGISTRY_URL, "
             "then https://crates.io.",
    )
    p.add_argument(
        "--venv-dir",
        default=".venv-test-install",
        help="Directory for the isolated throwaway test crate.",
    )
    p.add_argument(
        "--cargo-version",
        default=DEFAULT_CARGO_VERSION,
        help="cargo version to assert in the test crate ('none' to keep the active toolchain).",
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
        help="Stop after the first version that fetches successfully.",
    )
    p.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="Stream full cargo output for every step so failures are debuggable.",
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
          f"(registry: {cfg['RUST_REGISTRY_NAME']}).")
    cargo_version = None if str(args.cargo_version).lower() == "none" else args.cargo_version
    pip_path = setup_venv(args.venv_dir, cargo_version, cfg, verbose=args.verbose)
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
# Example — probe the newest 5 versions of serde, stop at the first installable:
#     main(["serde", "--registry", "https://reg.example.com",
#           "--limit", "5", "--first-only"])
#
# Equivalent on the command line:
#     python3 main.py serde \
#         --registry https://reg.example.com --limit 5 --first-only

if __name__ == "__main__":
    raise SystemExit(main())  # argv=None -> parse_args reads sys.argv
