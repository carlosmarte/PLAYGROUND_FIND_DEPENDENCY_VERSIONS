#!/usr/bin/env python3
"""Find installable versions of a provider from a (custom) Terraform registry.

Discovers every version a registry advertises for a provider via the registry
``/v1/providers/<ns>/<name>/versions`` API, then attempts to ``terraform init``
each one in an isolated temp configuration, recording success/failure per
version to a JSON report.

Example:
    python main.py hashicorp/aws \
        --registry registry.terraform.io

    # only probe the newest 5 versions, stop at the first that initialises
    python main.py hashicorp/aws --registry registry.terraform.io \
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

# terraform version the test environment is pinned to by default. Init-tests run
# against this terraform, so it governs provider-resolution behaviour. This is a
# soft pin (we only warn if terraform reports a different version) since the
# terraform binary is host-provided, not bootstrapped. Override via
# --terraform-version (CLI) or the `terraform` command (REPL).
DEFAULT_TERRAFORM_VERSION = "1.9.8"

# Environment knobs read via os.environ.get, each falling back to the value the
# Terraform ecosystem uses by default ("industry standard"). terraform itself
# auto-reads TF_* vars from the environment; we resolve them explicitly so the
# documented default still applies when the var is unset, and so they can be
# surfaced (REPL `env`) and threaded into every terraform invocation we build.
ENV_DEFAULTS = {
    "TF_VERBOSE": "0",                                  # our: quiet (0 = no TF_LOG)
    "TF_CLI_CONFIG_FILE": "",                           # terraform: CLI config (.terraformrc)
    "TF_PLUGIN_CACHE_DIR": "",                          # terraform: provider plugin cache
    "TF_REGISTRY": "registry.terraform.io",             # provider registry host for listing
    "TF_DEFAULT_TIMEOUT": "15",                         # our: 15s HTTP timeout
    "TF_RETRIES": "5",                                  # our: 5 connection retries
    "PROVIDER_REGISTRY_URL": "registry.terraform.io",   # our registry-host fallback
    "PROVIDER_REGISTRY_NAME": "Terraform Registry",     # registry display name
    "REQUESTS_CA_BUNDLE": "",                           # requests/urllib3: certifi
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
    """Pick the registry host: explicit flag > TF_REGISTRY > PROVIDER_REGISTRY_URL."""
    cfg = cfg or resolve_env()
    return explicit or cfg["TF_REGISTRY"] or cfg["PROVIDER_REGISTRY_URL"] or None


def terraform_options(cfg):
    """Translate resolved config into terraform command-line flags."""
    opts = []
    # terraform has no global verbosity flag (TF_LOG env var instead), but the
    # init step takes -no-color which we always pass for clean captured output.
    opts.append("-no-color")
    return opts


def subprocess_env(cfg):
    """Child-process environment with resolved TLS cert vars (and TF_LOG) applied."""
    env = os.environ.copy()
    for name in _TLS_ENV_VARS:
        if cfg[name]:
            env[name] = cfg[name]
    if cfg["TF_CLI_CONFIG_FILE"]:
        env["TF_CLI_CONFIG_FILE"] = cfg["TF_CLI_CONFIG_FILE"]
    if cfg["TF_PLUGIN_CACHE_DIR"]:
        env["TF_PLUGIN_CACHE_DIR"] = cfg["TF_PLUGIN_CACHE_DIR"]
    try:
        level = int(cfg["TF_VERBOSE"])
    except (TypeError, ValueError):
        level = 0
    if level > 0:
        env["TF_LOG"] = "DEBUG"  # terraform: verbose provider/registry logs
    return env


def _http_get_json(url, cfg, headers=None, verbose=False):
    """GET ``url`` and parse a JSON body via stdlib urllib (no third-party deps).

    Returns the decoded JSON object, or ``None`` on any HTTP/parse error (the
    caller degrades gracefully). ``verbose`` echoes the request and any error.
    """
    try:
        timeout = int(cfg["TF_DEFAULT_TIMEOUT"])
    except (TypeError, ValueError):
        timeout = 15
    req = urllib.request.Request(url, headers=headers or {})
    if verbose:
        print(f"  $ GET {url}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, ValueError) as e:
        if verbose:
            print(f"  ! {e}")
        return None


def get_available_versions(package, index_url, cfg=None, verbose=False):
    """Return the list of versions a registry advertises for ``package``.

    ``package`` is a ``<namespace>/<name>`` provider source address. Versions are
    returned newest-first; the registry ``versions`` endpoint lists oldest-first,
    so we reverse it. When ``verbose`` is set, the request and raw response are
    echoed so a failed or empty discovery can be debugged.
    """
    cfg = cfg or resolve_env()
    print(f"Retrieving versions for '{package}' from {index_url}...")
    url = f"https://{index_url}/v1/providers/{package}/versions"
    data = _http_get_json(url, cfg, verbose=verbose)
    if not data or not isinstance(data.get("versions"), list):
        print("Could not find 'versions' in registry response.", file=sys.stderr)
        return []
    versions = [v["version"] for v in data["versions"] if v.get("version")]
    return list(reversed(versions))  # API is oldest-first; we want newest-first


def setup_venv(env_dir, terraform_version=DEFAULT_TERRAFORM_VERSION, cfg=None, verbose=False):
    """Create a fresh sandbox directory if needed; return its path.

    For terraform the "sandbox" is a scratch working directory that each
    init-test writes a temp ``main.tf`` into (and where ``.terraform`` plugins
    land). The terraform binary is pinned to ``terraform_version`` (default
    ``DEFAULT_TERRAFORM_VERSION``) as a *soft* check — we warn on mismatch rather
    than bootstrap a binary. Pass ``terraform_version=None`` to skip the check.
    ``verbose`` echoes the version output so a failed check can be debugged.
    """
    cfg = cfg or resolve_env()
    if not os.path.exists(env_dir):
        print(f"Creating sandbox directory at: {env_dir}")
        os.makedirs(env_dir, exist_ok=True)

    # The "tool path" for terraform is the sandbox dir; temp configs are written
    # there and the terraform binary is on PATH (macOS / Linux / nt same name).
    sandbox_path = env_dir

    if terraform_version:
        _ensure_terraform_version(sandbox_path, terraform_version, cfg, verbose=verbose)
    return sandbox_path


def _ensure_terraform_version(sandbox_path, terraform_version, cfg=None, verbose=False):
    """Verify the terraform binary reports ``terraform_version`` (soft pin; warns)."""
    cfg = cfg or resolve_env()
    print(f"Ensuring terraform=={terraform_version} in the test environment...")
    cmd = ["terraform", "version", "-json"]
    if verbose:
        print(f"  $ {' '.join(cmd)}")
    res = subprocess.run(cmd, capture_output=True, text=True, env=subprocess_env(cfg))
    if verbose:
        _echo(res.stdout, res.stderr)
    found = ""
    try:
        found = json.loads(res.stdout or "{}").get("terraform_version", "")
    except json.JSONDecodeError:
        found = ""
    if res.returncode != 0 or found != terraform_version:
        print(
            f"Warning: could not pin terraform=={terraform_version}: "
            f"binary reports {found or 'unknown error'}",
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
    """True if terraform ``options`` already carry a verbose flag.

    terraform has no init-level verbosity flag (TF_LOG drives it via the env),
    so this is always False; kept for parity with the reference's flow.
    """
    return False


def _stream(cmd, env, cwd=None):
    """Run ``cmd``, echoing combined output live while capturing it.

    Returns ``(returncode, combined_output)``. Used in verbose mode so the user
    watches terraform in real time (e.g. a slow provider download or a hang) yet
    the captured text still feeds the JSON report.
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


def _write_config(work_dir, package, version):
    """Write a minimal ``main.tf`` pinning ``package`` to ``version``.

    terraform resolves providers from the ``required_providers`` block during
    ``init``; pinning ``version`` makes init succeed only if that exact version
    is downloadable from the registry.
    """
    alias = package.split("/")[-1].replace("-", "_")
    config = (
        "terraform {\n"
        "  required_providers {\n"
        f"    {alias} = {{\n"
        f'      source  = "{package}"\n'
        f'      version = "{version}"\n'
        "    }\n"
        "  }\n"
        "}\n"
    )
    with open(os.path.join(work_dir, "main.tf"), "w") as f:
        f.write(config)


def test_installations(sandbox_path, package, index_url, versions, output_json,
                       first_only=False, cfg=None, verbose=False):
    """Attempt to ``terraform init`` each version; write an incremental JSON report.

    Returns the list of result dicts. If ``first_only`` is set, stops after
    the first version that initialises successfully. When ``verbose`` is set,
    terraform's full output is streamed live (and TF_LOG=DEBUG is set via the
    env) so init failures can be debugged; the captured output is also folded
    into the report under ``log``/``error``.
    """
    cfg = cfg or resolve_env()
    env = subprocess_env(cfg)
    options = terraform_options(cfg)
    results = []
    installable = []

    for idx, version in enumerate(versions, start=1):
        target = f"{package}@{version}"
        print(f"[{idx}/{len(versions)}] Attempting to init: {target}...")

        # Each version gets its own scratch dir + temp main.tf so successive
        # inits do not collide on .terraform plugin state.
        work_dir = tempfile.mkdtemp(prefix="tf-", dir=sandbox_path)
        _write_config(work_dir, package, version)

        cmd = ["terraform", "init", "-input=false", "-backend=false"]
        cmd += options

        if verbose:
            print(f"  $ {' '.join(cmd)}  (cwd={work_dir})")
            returncode, output = _stream(cmd, env, cwd=work_dir)
            stdout_text = stderr_text = output  # streamed combined; same text both ways
        else:
            res = subprocess.run(cmd, capture_output=True, text=True, env=env, cwd=work_dir)
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
        description="Find installable versions of a provider from a Terraform registry.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("package", help="Provider to probe as <namespace>/<name> (e.g. hashicorp/aws).")
    p.add_argument(
        "--registry",
        dest="index_url",
        default=None,
        help="Custom provider registry host. Defaults to $TF_REGISTRY, "
             "then $PROVIDER_REGISTRY_URL, then registry.terraform.io.",
    )
    p.add_argument(
        "--venv-dir",
        default=".venv-test-install",
        help="Directory for the isolated init sandbox.",
    )
    p.add_argument(
        "--terraform-version",
        default=DEFAULT_TERRAFORM_VERSION,
        help="terraform version to expect ('none' to skip the check).",
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
        help="Stop after the first version that initialises successfully.",
    )
    p.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="Stream full terraform output for every step so failures are debuggable.",
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
          f"(registry: {cfg['PROVIDER_REGISTRY_NAME']}).")
    terraform_version = None if str(args.terraform_version).lower() == "none" else args.terraform_version
    sandbox_path = setup_venv(args.venv_dir, terraform_version, cfg, verbose=args.verbose)
    test_installations(
        sandbox_path,
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
# Example — probe the newest 5 versions of hashicorp/aws, stop at the first installable:
#     main(["hashicorp/aws", "--registry", "registry.terraform.io",
#           "--limit", "5", "--first-only"])
#
# Equivalent on the command line:
#     python3 main.py hashicorp/aws \
#         --registry registry.terraform.io --limit 5 --first-only

if __name__ == "__main__":
    raise SystemExit(main())  # argv=None -> parse_args reads sys.argv
