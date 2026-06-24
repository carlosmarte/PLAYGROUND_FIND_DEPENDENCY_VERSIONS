#!/usr/bin/env python3
"""Find installable versions of a module from a (custom) Go module proxy.

Discovers every version a proxy advertises for a module via
``go list -m -versions``, then attempts to fetch each one into an isolated
throwaway module, recording success/failure per version to a JSON report.

Example:
    python main.py github.com/stretchr/testify \
        --proxy https://my-proxy.example.com

    # only probe the newest 5 versions, stop at the first that fetches
    python main.py github.com/stretchr/testify --proxy https://proxy \
        --limit 5 --first-only
"""

import argparse
import json
import os
import signal
import subprocess
import sys

# go version the test environment is pinned to by default. Fetch-tests run
# against this toolchain, so it governs resolver/cooldown behaviour. Override via
# --go-version (CLI) or the `go` command (REPL). The go toolchain is whatever is
# on PATH; this is informational (Go selects the active toolchain).
DEFAULT_GO_VERSION = "1.23.4"

# Environment knobs read via os.environ.get, each falling back to the value the
# Go / module / TLS ecosystem uses by default ("industry standard"). go itself
# auto-reads GO* vars from the environment; we resolve them explicitly so the
# documented default still applies when the var is unset, and so they can be
# surfaced (REPL `env`) and threaded into every go invocation we build.
ENV_DEFAULTS = {
    "GO_VERBOSE": "0",                               # go: quiet (0 = no -x)
    "GOPROXY": "https://proxy.golang.org",           # go: module proxy
    "GOSUMDB": "sum.golang.org",                     # go: checksum database
    "GOFLAGS": "",                                    # go: extra flags injected
    "GONOSUMCHECK": "",                               # go: skip checksum (legacy)
    "GOINSECURE": "",                                 # go: hosts allowed over HTTP
    "GOPRIVATE": "",                                  # go: private module globs
    "GO_REGISTRY_URL": "https://proxy.golang.org",   # our proxy fallback
    "GO_REGISTRY_NAME": "proxy.golang.org",          # registry display name
    "SSL_CERT_FILE": "",                             # OpenSSL: system CA file
    "SSL_CERT_DIR": "",                              # OpenSSL: system CA dir
}

# TLS vars passed through to child processes via the environment (no CLI flag).
_TLS_ENV_VARS = ("SSL_CERT_FILE", "SSL_CERT_DIR")


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
    """Pick the proxy URL: explicit flag > GOPROXY > GO_REGISTRY_URL."""
    cfg = cfg or resolve_env()
    return explicit or cfg["GOPROXY"] or cfg["GO_REGISTRY_URL"] or None


def go_options(cfg):
    """Translate resolved config into go command-line flags."""
    opts = []
    try:
        level = int(cfg["GO_VERBOSE"])
    except (TypeError, ValueError):
        level = 0
    if level > 0:
        opts.append("-x")  # go -x: print the commands it runs
    if cfg["GOFLAGS"]:
        opts += cfg["GOFLAGS"].split()
    return opts


def subprocess_env(cfg):
    """Child-process environment with resolved proxy/TLS cfg applied."""
    env = os.environ.copy()
    for name in _TLS_ENV_VARS:
        if cfg[name]:
            env[name] = cfg[name]
    # Thread Go's module knobs through so every go child obeys them.
    env["GOPROXY"] = cfg["GOPROXY"]
    env["GOSUMDB"] = cfg["GOSUMDB"]
    for name in ("GOFLAGS", "GOINSECURE", "GOPRIVATE", "GONOSUMCHECK"):
        if cfg[name]:
            env[name] = cfg[name]
    return env


def get_available_versions(package, index_url, cfg=None, verbose=False):
    """Return the list of versions a proxy advertises for ``package``.

    Versions are returned newest-first. ``go list -m -versions`` prints them
    space-separated oldest-first, so we reverse to match ``pip``'s newest-first
    contract. When ``verbose`` is set, the go command and its raw output are
    echoed so a failed or empty discovery can be debugged.
    """
    cfg = cfg or resolve_env()
    print(f"Retrieving versions for '{package}' from {index_url}...")
    cmd = [
        "go",
        "list",
        "-m",
        "-versions",
        package,
    ]
    # Strip go's verbose flag (`-x`, not `-v`) for this query: we only need the
    # single line of space-separated versions, but `-x` makes go print every
    # command it runs — a flood of output that bloats the captured buffer (and
    # overflows the Node twin's spawnSync limit). Keep the discovery query quiet.
    cmd += _strip_verbose(go_options(cfg))
    env = subprocess_env(cfg)
    if index_url:
        env["GOPROXY"] = index_url  # -versions reads the proxy from GOPROXY
    if verbose:
        print(f"  $ GOPROXY={env.get('GOPROXY')} {' '.join(cmd)}")

    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, check=True, env=env
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
            f"Error running 'go list -m -versions': {detail or 'unknown error'}",
            file=sys.stderr,
        )
        sys.exit(1)

    if verbose:
        _echo(result.stdout)
    # Output: "<module> v1.0.0 v1.1.0 v1.2.0" (module name first, then versions
    # oldest-first). Drop the module token, then reverse for newest-first.
    tokens = result.stdout.split()
    if not tokens:
        print("Could not find any versions in 'go list' output.", file=sys.stderr)
        return []
    versions = [t for t in tokens[1:] if t.startswith("v")]
    if not versions:
        print("Could not find any versions in 'go list' output.", file=sys.stderr)
        return []
    return list(reversed(versions))  # go lists oldest-first; we want newest-first


def setup_venv(env_dir, go_version=DEFAULT_GO_VERSION, cfg=None, verbose=False):
    """Create a fresh throwaway module if needed; return its directory path.

    The sandbox is a temp module (``go mod init tmp``) into which each candidate
    version is fetched. The active toolchain is reported as ``go_version``
    (default ``DEFAULT_GO_VERSION``) so fetch-tests run against a known go. Pass
    ``go_version=None`` to keep whatever go is on PATH. ``verbose`` echoes the
    init output so a failed scaffold can be debugged.
    """
    cfg = cfg or resolve_env()
    if not os.path.exists(os.path.join(env_dir, "go.mod")):
        print(f"Creating throwaway module at: {env_dir}")
        os.makedirs(env_dir, exist_ok=True)
        init = subprocess.run(
            ["go", "mod", "init", "tmp"],
            capture_output=True, text=True, env=subprocess_env(cfg), cwd=env_dir,
        )
        if verbose:
            _echo(init.stdout, init.stderr)
        if init.returncode != 0:
            print(
                f"Warning: could not init throwaway module: "
                f"{_last_line(init.stderr) or 'unknown error'}",
                file=sys.stderr,
            )

    if go_version:
        _ensure_pip_version(env_dir, go_version, cfg, verbose=verbose)
    return env_dir


def _ensure_pip_version(env_dir, go_version, cfg=None, verbose=False):
    """Report the active go toolchain (PATH, not the module dir, owns it)."""
    cfg = cfg or resolve_env()
    print(f"Ensuring go=={go_version} in the test environment...")
    cmd = ["go", "version"]
    if verbose:
        print(f"  $ {' '.join(cmd)}")
    res = subprocess.run(cmd, capture_output=True, text=True, env=subprocess_env(cfg))
    if verbose:
        _echo(res.stdout, res.stderr)
    if res.returncode != 0:
        print(
            f"Warning: could not confirm go=={go_version}: "
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
    """True if go ``options`` already carry a ``-x``/``-v`` flag."""
    return any(o in ("-x", "-v") for o in options)


def _strip_verbose(options):
    """Return ``options`` with go's verbose flag (``-x``) removed."""
    return [o for o in options if o != "-x"]


def _stream(cmd, env, cwd=None):
    """Run ``cmd``, echoing combined output live while capturing it.

    Returns ``(returncode, combined_output)``. Used in verbose mode so the user
    watches go in real time (e.g. a slow build or a hang) yet the captured text
    still feeds the JSON report.
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

    ``pip_path`` is the throwaway module directory from ``setup_venv``. Returns
    the list of result dicts. If ``first_only`` is set, stops after the first
    version that fetches successfully. When ``verbose`` is set, go's full output
    is streamed live (and a ``-x`` flag is added if none is present) so fetch
    failures can be debugged; the captured output is also folded into the report
    under ``log``/``error``.
    """
    cfg = cfg or resolve_env()
    env = subprocess_env(cfg)
    if index_url:
        env["GOPROXY"] = index_url
    options = go_options(cfg)
    results = []
    installable = []

    for idx, version in enumerate(versions, start=1):
        target = f"{package}@{version}"
        print(f"[{idx}/{len(versions)}] Attempting to fetch: {target}...")

        cmd = [
            "go",
            "get",
            target,
        ]
        cmd += options
        # Bump go's verbosity if the user wants detail and nothing already set it.
        if verbose and not _has_verbose(options):
            cmd.append("-x")

        if verbose:
            print(f"  $ (cd {pip_path} && GOPROXY={env.get('GOPROXY')} {' '.join(cmd)})")
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
        description="Find installable versions of a module from a Go module proxy.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("package", help="Module path to probe (e.g. github.com/stretchr/testify).")
    p.add_argument(
        "--proxy",
        dest="index_url",
        default=None,
        help="Custom Go module proxy URL. Defaults to $GOPROXY, then "
             "$GO_REGISTRY_URL, then https://proxy.golang.org.",
    )
    p.add_argument(
        "--venv-dir",
        default=".venv-test-install",
        help="Directory for the isolated throwaway test module.",
    )
    p.add_argument(
        "--go-version",
        default=DEFAULT_GO_VERSION,
        help="go version to assert in the test module ('none' to keep the active toolchain).",
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
        help="Stream full go output for every step so failures are debuggable.",
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
          f"(registry: {cfg['GO_REGISTRY_NAME']}).")
    go_version = None if str(args.go_version).lower() == "none" else args.go_version
    pip_path = setup_venv(args.venv_dir, go_version, cfg, verbose=args.verbose)
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
# Example — probe the newest 5 versions of testify, stop at the first installable:
#     main(["github.com/stretchr/testify", "--proxy", "https://proxy.example.com",
#           "--limit", "5", "--first-only"])
#
# Equivalent on the command line:
#     python3 main.py github.com/stretchr/testify \
#         --proxy https://proxy.example.com --limit 5 --first-only

if __name__ == "__main__":
    raise SystemExit(main())  # argv=None -> parse_args reads sys.argv
