# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
The CLI's one output surface: every user-facing line goes through here so the
whole tool speaks with the same palette, symbols and spinner.

Messages are emitted as literal text, never as rich markup, so a path or an
error containing square brackets can't be swallowed as a style tag.
"""

from contextlib import contextmanager

from rich.console import Console
from rich.text import Text

from canyonos.theme import GRADIENT, GREEN, WHITE

console = Console()
# For notices that are not the command's result, so `--json` output on stdout
# stays a single parseable object.
err_console = Console(stderr=True)


def set_quiet(quiet):
    """Silence every helper here, so `canyonos test --json` emits only its payload."""
    console.quiet = quiet


def _emit(message, style, symbol=None, target=console):
    parts = [(f"{symbol} ", style)] if symbol else []
    parts.append((str(message), WHITE if symbol else style))
    target.print(Text.assemble(*parts))


def say(message):
    """Show a plain message in the terminal."""
    _emit(message, WHITE)


def ok(message):
    """Show a success message in the terminal, marked with a green ✓."""
    _emit(message, GREEN, "✓")


def fail(message):
    """Show an error message in the terminal, marked with a red ✗."""
    _emit(message, "bold red", "✗")


def root_cause(message):
    """Show the line that explains a failure, marked with a bright red ✗."""
    console.print(Text(f"✗ Root Cause: {message}", style="bold bright_red"))


def warn(message):
    """Show a warning in the terminal, marked with a yellow !."""
    _emit(message, "yellow", "!")


def notice(message, urgent=False):
    """Show a warning on stderr, apart from the command's own output: marked with a
    yellow !, or a bold red one when `urgent`."""
    _emit(message, "bold red" if urgent else "yellow", "!", err_console)


def hint(message):
    """Show a dimmed hint in the terminal, such as the next command to run."""
    _emit(message, "dim")


def command(text):
    """Show a command to copy in the terminal, dimmed and never wrapped, so even a long
    one pastes back as one line."""
    console.print(Text(str(text), style="dim"), soft_wrap=True)


def blank():
    """Show an empty line in the terminal."""
    console.print()


def gradient(text):
    """Print `text` line by line down the brand ramp (the `init` banner)."""
    for line, color in zip(text.splitlines(), GRADIENT):
        console.print(line, style=color)


def panel(renderable):
    """Show a Rich panel or table in the terminal; hidden when `--json` output is on."""
    console.print(renderable)


@contextmanager
def status(message):
    """Show a spinner and `message` in the terminal while the `with` block runs."""
    with console.status(message) as spinner:
        yield spinner
