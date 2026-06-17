#!/usr/bin/env python3
"""Interactive REPL front-end — a thin shell over the SDK.

    cli.py (this REPL)  ->  sdk.TwineVersionsSDK  ->  main.py

The REPL holds no engine logic of its own: it parses line input, maps it onto
the SDK's ``config``, and calls SDK methods. Anything the REPL can do, an
external caller can do by driving the same ``sdk.TwineVersionsSDK`` directly.

NOTE: twine is publish-side; this clone repurposes ``twine check`` as a
metadata-validity probe — see ``main.py``'s module docstring.

Run it interactively:
    python3 cli.py

Or run a single command non-interactively (handy as a container entrypoint) by
passing it as args — the tokens become one REPL command line, then the process
exits:
    python3 cli.py versions numpy
    python3 cli.py run numpy --limit 5 --first-only -v

Then, at the (twine-versions) prompt:
    registry https://my-registry.example.com/simple
    versions numpy        # list what the registry advertises
    find numpy            # check until the first version whose metadata validates
    test numpy            # metadata-check every version, write a JSON report
    test numpy 10         # metadata-check only the newest 10 versions
    verbose on            # stream full pip/twine output to debug failures
    help                  # full command list
    quit
"""

import cmd
import os
import shlex
import sys

import sdk


class TwineVersionsREPL(cmd.Cmd):
    intro = (
        "twine-versions interactive shell. Type 'help' or '?' for commands, "
        "'show' for current settings, 'quit' to exit."
    )
    prompt = "(twine-versions) "

    def __init__(self, client=None):
        super().__init__()
        # All session state lives in the SDK's config — the REPL is a view onto
        # it. Inject a custom/extended SDK via ``client`` to reuse this shell.
        self.sdk = client or sdk.TwineVersionsSDK()

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
        print(f"index-url = {self.sdk.effective_index_url() or '(default index)'}")

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
        """venv [DIR]  — set or show the scratch download dir (resets the env)."""
        arg = arg.strip()
        if arg:
            self.cfg.venv_dir = arg
            self.sdk.invalidate_venv()  # force re-create against the new dir
        print(f"venv-dir = {self.cfg.venv_dir}")

    def do_twine(self, arg):
        """twine [VERSION|none]  — set or show the twine version expected for the probe."""
        arg = arg.strip()
        if arg:
            self.cfg.twine_version = arg
            self.sdk.invalidate_venv()  # re-check on next metadata-test
        print(f"twine-version = {self.cfg.twine_version}")

    def do_verbose(self, arg):
        """verbose [on|off]  — stream full pip/twine output so checks are debuggable.

        With no argument, toggles. When on, every find/test streams the live
        output (and a copy lands in the report) so you can see why a version
        failed its metadata check.
        """
        arg = arg.strip().lower()
        if arg in ("on", "true", "1", "yes"):
            self.cfg.verbose = True
        elif arg in ("off", "false", "0", "no"):
            self.cfg.verbose = False
        elif arg == "":
            self.cfg.verbose = not self.cfg.verbose  # bare 'verbose' toggles
        else:
            print("Usage: verbose [on|off]")
            return
        print(f"verbose = {'on' if self.cfg.verbose else 'off'}")

    def do_show(self, arg):
        """show  — print the current session settings."""
        print(f"  index-url = {self.sdk.effective_index_url() or '(default index)'}")
        print(f"  package   = {self.cfg.package or '(unset)'}")
        print(f"  limit     = {self.cfg.limit if self.cfg.limit is not None else 'none'}")
        print(f"  output    = {self.cfg.output}")
        print(f"  venv-dir  = {self.cfg.venv_dir}")
        print(f"  twine     = {self.cfg.twine_version}")
        print(f"  verbose   = {'on' if self.cfg.verbose else 'off'}")

    def do_env(self, arg):
        """env  — show the resolved twine/TLS env vars (os.environ or default)."""
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
        """find [PACKAGE]  — check until the first version whose metadata validates."""
        pkg = self._resolve_package(arg)
        if not pkg:
            return
        try:
            self.sdk.find(pkg)
        except sdk.TwineVersionsError as e:
            print(e)

    def do_test(self, arg):
        """test [PACKAGE] [MAX]  — metadata-check versions (newest first), write the JSON report.

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
        except sdk.TwineVersionsError as e:
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


def main(argv=None):
    """Run a single command from ``argv``, or an interactive shell if none.

    Passing args runs them as one REPL command line and exits — this is what
    makes the shell usable as a container entrypoint::

        docker run <image> versions numpy        # -> REPL: `versions numpy`
        docker run <image> run numpy --limit 5   # -> batch via main.main
        docker run -it <image>                   # -> interactive REPL

    """
    argv = sys.argv[1:] if argv is None else argv
    repl = TwineVersionsREPL()
    try:
        if argv:
            repl.onecmd(" ".join(argv))  # one-shot, then exit
            return 0
        repl.cmdloop()
    except KeyboardInterrupt:
        print("\nInterrupted.")
        return 130
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
