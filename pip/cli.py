#!/usr/bin/env python3
"""Interactive REPL front-end — a thin shell over the SDK.

    cli.py (this REPL)  ->  sdk.PipVersionsSDK  ->  main.py

The REPL holds no engine logic of its own: it parses line input, maps it onto
the SDK's ``config``, and calls SDK methods. Anything the REPL can do, an
external caller can do by driving the same ``sdk.PipVersionsSDK`` directly.

Run it:
    python3 cli.py

Then, at the (pip-versions) prompt:
    registry https://my-registry.example.com/simple
    versions numpy        # list what the registry advertises
    find numpy            # install-test until the first version that works
    test numpy            # install-test every version, write a JSON report
    test numpy 10         # install-test only the newest 10 versions
    help                  # full command list
    quit
"""

import cmd
import os
import shlex

import sdk


class PipVersionsREPL(cmd.Cmd):
    intro = (
        "pip-versions interactive shell. Type 'help' or '?' for commands, "
        "'show' for current settings, 'quit' to exit."
    )
    prompt = "(pip-versions) "

    def __init__(self, client=None):
        super().__init__()
        # All session state lives in the SDK's config — the REPL is a view onto
        # it. Inject a custom/extended SDK via ``client`` to reuse this shell.
        self.sdk = client or sdk.PipVersionsSDK()

    # -- helpers -----------------------------------------------------------

    @property
    def cfg(self):
        return self.sdk.config

    def _resolve_package(self, arg):
        """Return the package from `arg`, falling back to the session package."""
        pkg = arg.strip() or self.cfg.package
        if not pkg:
            print("No package set. Use 'package <name>' or pass one inline.")
        elif arg.strip():
            self.cfg.package = pkg  # inline package becomes the session default
        return pkg

    def _parse_package_and_max(self, arg):
        """Split ``arg`` into ``(package, max_versions)``.

        A trailing integer token is taken as the MAX cap; the rest is the
        package (falling back to the session package when omitted). On an
        invalid MAX, prints an error and returns ``(None, None)`` so the
        caller's ``if not pkg`` guard aborts the command.
        """
        tokens = arg.split()
        max_versions = None
        if tokens:
            try:
                candidate = int(tokens[-1])
            except ValueError:
                candidate = None
            if candidate is not None:
                if candidate < 1:
                    print("MAX must be a positive integer.")
                    return None, None
                max_versions = candidate
                tokens = tokens[:-1]
        return self._resolve_package(" ".join(tokens)), max_versions

    # -- configuration commands -------------------------------------------

    def do_registry(self, arg):
        """registry [URL]  — set or show the index URL ('none' to clear)."""
        arg = arg.strip()
        if arg:
            self.cfg.index_url = None if arg.lower() == "none" else arg
        print(f"index-url = {self.sdk.effective_index_url() or '(pip default)'}")

    do_index = do_registry  # alias

    def do_package(self, arg):
        """package [NAME]  — set or show the default package."""
        arg = arg.strip()
        if arg:
            self.cfg.package = arg
        print(f"package = {self.cfg.package or '(unset)'}")

    def do_limit(self, arg):
        """limit [N|none]  — only probe the newest N versions ('none' = all)."""
        arg = arg.strip().lower()
        if not arg:
            print(f"limit = {self.cfg.limit if self.cfg.limit is not None else 'none'}")
            return
        if arg == "none":
            self.cfg.limit = None
        else:
            try:
                self.cfg.limit = max(1, int(arg))
            except ValueError:
                print("limit must be an integer or 'none'.")
                return
        print(f"limit = {self.cfg.limit if self.cfg.limit is not None else 'none'}")

    def do_output(self, arg):
        """output [PATH]  — set or show the JSON report path."""
        arg = arg.strip()
        if arg:
            self.cfg.output = arg
        print(f"output = {self.cfg.output}")

    def do_venv(self, arg):
        """venv [DIR]  — set or show the test virtualenv dir (resets the env)."""
        arg = arg.strip()
        if arg:
            self.cfg.venv_dir = arg
            self.sdk.invalidate_venv()  # force re-create against the new dir
        print(f"venv-dir = {self.cfg.venv_dir}")

    def do_pip(self, arg):
        """pip [VERSION|none]  — set or show the pip version pinned in the test venv."""
        arg = arg.strip()
        if arg:
            self.cfg.pip_version = arg
            self.sdk.invalidate_venv()  # re-pin on next install-test
        print(f"pip-version = {self.cfg.pip_version}")

    def do_show(self, arg):
        """show  — print the current session settings."""
        print(f"  index-url = {self.sdk.effective_index_url() or '(pip default)'}")
        print(f"  package   = {self.cfg.package or '(unset)'}")
        print(f"  limit     = {self.cfg.limit if self.cfg.limit is not None else 'none'}")
        print(f"  output    = {self.cfg.output}")
        print(f"  venv-dir  = {self.cfg.venv_dir}")
        print(f"  pip       = {self.cfg.pip_version}")

    def do_env(self, arg):
        """env  — show the resolved pip/TLS env vars (os.environ or default)."""
        cfg = self.sdk.resolve_env()
        width = max(len(k) for k in cfg)
        for name in sdk.ENV_DEFAULTS:
            source = "env" if name in os.environ else "default"
            value = cfg[name] if cfg[name] != "" else "(unset)"
            print(f"  {name.ljust(width)} = {value}  [{source}]")

    # -- action commands ---------------------------------------------------

    def do_versions(self, arg):
        """versions [PACKAGE]  — list versions the registry advertises."""
        pkg = self._resolve_package(arg)
        if not pkg:
            return
        versions = self.sdk.available_versions(pkg)
        if not versions:
            print("No versions found.")
            return
        print(f"{len(versions)} version(s) for '{pkg}':")
        print("  " + ", ".join(versions))

    def do_find(self, arg):
        """find [PACKAGE]  — install-test until the first version that works."""
        pkg = self._resolve_package(arg)
        if not pkg:
            return
        try:
            self.sdk.find(pkg)
        except sdk.PipVersionsError as e:
            print(e)

    def do_test(self, arg):
        """test [PACKAGE] [MAX]  — install-test versions (newest first), write the JSON report.

        An optional trailing MAX caps how many versions to test this run,
        overriding the session `limit`. Examples:
            test numpy        # every version the registry advertises
            test numpy 10     # only the newest 10
            test 10           # newest 10 of the session package
        """
        pkg, max_versions = self._parse_package_and_max(arg)
        if not pkg:
            return
        kwargs = {} if max_versions is None else {"limit": max_versions}
        try:
            self.sdk.test(pkg, **kwargs)
        except sdk.PipVersionsError as e:
            print(e)

    def do_run(self, arg):
        """run ARGS...  — pass raw CLI args straight through the SDK to main.

        Example: run numpy --limit 5 --first-only
        """
        argv = shlex.split(arg)
        if not argv:
            print("Usage: run <package> [--index-url URL] [--limit N] [--first-only]")
            return
        self.sdk.run(argv)

    # -- exit --------------------------------------------------------------

    def do_quit(self, arg):
        """quit  — leave the shell."""
        print("Bye.")
        return True

    do_exit = do_quit
    do_EOF = do_quit  # Ctrl-D

    def emptyline(self):
        pass  # do nothing on a blank line (default would repeat last command)


def main():
    try:
        PipVersionsREPL().cmdloop()
    except KeyboardInterrupt:
        print("\nInterrupted.")
        return 130
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
