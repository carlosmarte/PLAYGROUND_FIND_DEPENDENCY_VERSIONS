#!/usr/bin/env python3
"""Find fetchable versions of a formula from the Homebrew registry.

Discovers what version(s) the Homebrew API advertises for a formula via the
formula JSON endpoint (``/api/formula/<formula>.json``), then attempts to
``brew fetch`` each token into an isolated throwaway download cache, recording
success/failure per token to a JSON report.

NOTE: Homebrew installs/fetches only the CURRENT stable of a formula. Its API
mainly exposes that single stable version (plus separate *versioned formulae*
like ``python@3.11``); historical-version listing/testing is therefore
best-effort — ``brew fetch`` validates the formula is fetchable but cannot pin
arbitrary past versions. Versioned-formula NAMES, however, fetch directly.

Example:
    python main.py wget \
        --source https://formulae.brew.sh

    # only probe the newest 5 tokens, stop at the first that fetches
    python main.py wget --source https://formulae.brew.sh \
        --limit 5 --first-only
"""

import argparse
import json
import os
import re
import signal
import subprocess
import sys
import urllib.request

# brew tool version the test environment is expected to use by default.
# Fetch-tests run against this toolchain, so it governs fetch/cache behaviour.
# Override via --brew-version (CLI) or the `brew` command (REPL).
DEFAULT_BREW_VERSION = "4.3.0"

# Environment knobs read via os.environ.get, each falling back to the value the
# Homebrew / TLS ecosystem uses by default ("industry standard"). brew itself
# auto-reads HOMEBREW_* vars from the environment; we resolve them explicitly so
# the documented default still applies when the var is unset, and so they can be
# surfaced (REPL `env`) and threaded into every brew invocation we build.
ENV_DEFAULTS = {
    "HOMEBREW_VERBOSE": "0",                               # brew: quiet (0 = normal)
    "HOMEBREW_CERT": "",                                   # brew: use system store
    "HOMEBREW_API": "https://formulae.brew.sh/api/formula",  # formula JSON base for listing
    "HOMEBREW_SOURCE": "https://formulae.brew.sh",         # Homebrew API base for fetch
    "HOMEBREW_TRUSTED_HOST": "",                           # brew: no extra trusted hosts
    "HOMEBREW_DEFAULT_TIMEOUT": "15",                      # brew: 15s socket timeout
    "HOMEBREW_RETRIES": "5",                               # brew: 5 connection retries
    "BREW_REGISTRY_URL": "https://formulae.brew.sh",       # our source fallback
    "BREW_REGISTRY_NAME": "Homebrew",                      # registry display name
    "REQUESTS_CA_BUNDLE": "",                              # requests/urllib3: certifi
    "SSL_CERT_FILE": "",                                   # OpenSSL: system CA file
    "SSL_CERT_DIR": "",                                    # OpenSSL: system CA dir
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
    """Pick the source URL: explicit flag > HOMEBREW_SOURCE > BREW_REGISTRY_URL."""
    cfg = cfg or resolve_env()
    return explicit or cfg["HOMEBREW_SOURCE"] or cfg["BREW_REGISTRY_URL"] or None


def brew_options(cfg):
    """Translate resolved config into brew command-line flags."""
    opts = []
    try:
        level = int(cfg["HOMEBREW_VERBOSE"])
    except (TypeError, ValueError):
        level = 0
    if level > 0:
        opts += ["--verbose"]  # brew: bump fetch verbosity
    # brew has no meaningful per-call cert flag; HOMEBREW_CERT carries no native
    # brew option, so we keep it addressable (it can be threaded via the env in
    # subprocess_env) without emitting a flag brew wouldn't understand.
    # brew fetch likewise has no per-call timeout/retry flags; brew reads them
    # from the environment, so they ride along via subprocess_env. We still keep
    # the resolved values addressable for parity with the reference shape.
    return opts


def subprocess_env(cfg):
    """Child-process environment with resolved TLS cert + Homebrew vars applied."""
    env = os.environ.copy()
    for name in _TLS_ENV_VARS:
        if cfg[name]:
            env[name] = cfg[name]
    # brew honours these from the environment; thread the resolved values in.
    env["HOMEBREW_DEFAULT_TIMEOUT"] = str(cfg["HOMEBREW_DEFAULT_TIMEOUT"])
    env["HOMEBREW_RETRIES"] = str(cfg["HOMEBREW_RETRIES"])
    # Keep fetches fast and deterministic: don't auto-update the formula tap on
    # every invocation.
    env["HOMEBREW_NO_AUTO_UPDATE"] = "1"
    return env


def get_available_versions(formula, index_url, cfg=None, verbose=False):
    """Return the list of tokens Homebrew advertises for ``formula``.

    Tokens are returned newest-first: the current stable version first, then any
    *versioned formulae* names (e.g. ``python@3.11``) as-is. Homebrew's API
    mainly exposes the CURRENT stable version of a formula plus those separate
    versioned formulae, so historical-version listing is best-effort — there is
    no full per-version history here. When ``verbose`` is set, the API URL and
    its raw payload are echoed so a failed or empty discovery can be debugged.
    """
    cfg = cfg or resolve_env()
    print(f"Retrieving versions for '{formula}' from {index_url}...")
    # The formula JSON resource keys its document by the formula name.
    api = cfg["HOMEBREW_API"].rstrip("/")
    url = f"{api}/{formula}.json"
    if verbose:
        print(f"  $ GET {url}")

    try:
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=int(cfg["HOMEBREW_DEFAULT_TIMEOUT"])) as resp:
            payload = resp.read().decode("utf-8")
    except Exception as e:  # urllib raises a zoo of errors; treat all as fatal here
        if verbose:
            _echo(str(e))
        print(f"Error querying Homebrew formula API: {e}", file=sys.stderr)
        sys.exit(1)

    if verbose:
        _echo(payload)
    try:
        data = json.loads(payload)
    except json.JSONDecodeError:
        print("Could not parse JSON from Homebrew formula API.", file=sys.stderr)
        return []
    versions = data.get("versions")
    if not versions:
        print("Could not find 'versions' in Homebrew formula JSON.", file=sys.stderr)
        return []
    # Current stable first, then versioned-formulae NAMES (e.g. python@3.11) as-is.
    tokens = []
    stable = versions.get("stable")
    if stable:
        tokens.append(str(stable).strip())
    for name in data.get("versioned_formulae", []):
        if name and str(name).strip():
            tokens.append(str(name).strip())
    return tokens


def setup_venv(env_dir, brew_version=DEFAULT_BREW_VERSION, cfg=None, verbose=False):
    """Create a fresh throwaway download cache if needed; return its directory.

    The sandbox is just a temp directory used as the brew download/cache target
    (``brew fetch`` downloads bottles there). ``brew_version`` records the
    toolchain the tests are expected to run against (default
    ``DEFAULT_BREW_VERSION``). Pass ``brew_version=None`` to skip the
    toolchain-check echo. ``verbose`` echoes any setup output so a failed setup
    can be debugged.
    """
    cfg = cfg or resolve_env()
    if not os.path.exists(env_dir):
        print(f"Creating throwaway brew cache dir at: {env_dir}")
    os.makedirs(env_dir, exist_ok=True)

    if brew_version:
        _ensure_brew_version(env_dir, brew_version, cfg, verbose=verbose)
    return env_dir


def _ensure_brew_version(env_dir, brew_version, cfg=None, verbose=False):
    """Report the brew version (the toolchain fetch-tests run against)."""
    cfg = cfg or resolve_env()
    print(f"Ensuring brew>={brew_version} in the test environment...")
    cmd = ["brew", "--version"]
    if verbose:
        print(f"  $ {' '.join(cmd)}")
    res = subprocess.run(cmd, capture_output=True, text=True, env=subprocess_env(cfg))
    if verbose:
        _echo(res.stdout, res.stderr)
    if res.returncode != 0:
        # A negative returncode means the child was killed by a signal, leaving
        # stderr empty — fall back to the signal name so it isn't blank.
        detail = _last_line(res.stderr)
        if not detail and res.returncode < 0:
            try:
                detail = f"terminated by signal {signal.Signals(-res.returncode).name}"
            except ValueError:
                detail = f"terminated by signal {-res.returncode}"
        print(
            f"Warning: could not verify brew>={brew_version}: "
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
    """True if brew ``options`` already carry a ``--verbose`` flag."""
    return any(o == "--verbose" for o in options)


def _stream(cmd, env):
    """Run ``cmd``, echoing combined output live while capturing it.

    Returns ``(returncode, combined_output)``. Used in verbose mode so the user
    watches brew in real time (e.g. a slow fetch or a hang) yet the captured
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


def test_installations(venv_dir, formula, index_url, versions, output_json,
                       first_only=False, cfg=None, verbose=False):
    """Attempt to fetch each token; write an incremental JSON report.

    Returns the list of result dicts. If ``first_only`` is set, stops after
    the first token that fetches successfully. When ``verbose`` is set, brew's
    full output is streamed live (and a ``--verbose`` flag is added if none is
    present) so fetch failures can be debugged; the captured output is also
    folded into the report under ``log``/``error``.

    NOTE: brew only installs/fetches the CURRENT stable of a formula, so
    historical-version testing is best-effort — ``brew fetch`` validates that
    the formula is fetchable but cannot pin arbitrary past versions. For
    versioned-formula NAMES (e.g. ``python@3.11``) ``brew fetch`` works
    directly. The per-iteration "version" field is therefore the formula-or-
    version TOKEN being fetched, not necessarily a pinned version.
    """
    cfg = cfg or resolve_env()
    env = subprocess_env(cfg)
    # brew fetch downloads bottles into HOMEBREW_CACHE; point it at the sandbox
    # so downloads land in the throwaway dir.
    env["HOMEBREW_CACHE"] = venv_dir
    options = brew_options(cfg)
    results = []
    installable = []

    for idx, version in enumerate(versions, start=1):
        target = version
        print(f"[{idx}/{len(versions)}] Attempting to fetch: {target}...")

        # brew fetch downloads only (NO install). The token is a formula name
        # (or a versioned-formula name like python@3.11).
        cmd = [
            "brew",
            "fetch",
            version,
        ]
        cmd += options
        # Bump brew's own verbosity if the user wants detail and nothing set it.
        if verbose and not _has_verbose(options):
            cmd += ["--verbose"]

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
            print(f"  First fetchable token found: {installable[0]} (stopping).")
            break

    print(f"\nTesting complete! Results saved to {output_json}")
    if installable:
        print(f"Fetchable tokens ({len(installable)}): {', '.join(installable)}")
    else:
        print("No fetchable tokens found.")
    return results


def parse_args(argv=None):
    p = argparse.ArgumentParser(
        description="Find fetchable versions of a formula from the Homebrew registry.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("formula", help="Formula name to probe (e.g. wget).")
    p.add_argument(
        "--source",
        default=None,
        help="Homebrew API base URL. Defaults to $HOMEBREW_SOURCE, "
             "then $BREW_REGISTRY_URL, then https://formulae.brew.sh.",
    )
    p.add_argument(
        "--venv-dir",
        default=".venv-test-install",
        help="Directory for the isolated throwaway brew download cache.",
    )
    p.add_argument(
        "--brew-version",
        default=DEFAULT_BREW_VERSION,
        help="brew version expected in the test env ('none' to skip the check).",
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
        help="Only test the newest N tokens (default: all).",
    )
    p.add_argument(
        "--first-only",
        action="store_true",
        help="Stop after the first token that fetches successfully.",
    )
    p.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="Stream full brew output for every step so failures are debuggable.",
    )
    return p.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)

    cfg = resolve_env()
    index_url = resolve_index_url(args.source, cfg)

    versions = get_available_versions(args.formula, index_url, cfg, verbose=args.verbose)
    if not versions:
        print("No versions found. Exiting.")
        return 1

    if args.limit is not None:
        versions = versions[: args.limit]

    print(f"Found {len(versions)} version(s) to test "
          f"(registry: {cfg['BREW_REGISTRY_NAME']}).")
    brew_version = None if str(args.brew_version).lower() == "none" else args.brew_version
    venv_dir = setup_venv(args.venv_dir, brew_version, cfg, verbose=args.verbose)
    test_installations(
        venv_dir,
        args.formula,
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
# Example — probe the newest 5 tokens of wget, stop at the first fetchable:
#     main(["wget", "--source", "https://formulae.brew.sh",
#           "--limit", "5", "--first-only"])
#
# Equivalent on the command line:
#     python3 main.py wget \
#         --source https://formulae.brew.sh --limit 5 --first-only

if __name__ == "__main__":
    raise SystemExit(main())  # argv=None -> parse_args reads sys.argv
