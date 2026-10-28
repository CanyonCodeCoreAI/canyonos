# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
The CLI's one output surface: every user-facing line goes through here so the
whole tool speaks with the same palette, symbols and spinner.

Messages are emitted as literal text, never as rich markup, so a path or an
error containing square brackets can't be swallowed as a style tag.
"""

import sys
from contextlib import contextmanager
from types import SimpleNamespace

from rich.console import Console
from rich.text import Text

from canyonos.os_support import is_terminal
from canyonos.theme import GRADIENT, GREEN, WHITE

# Off a terminal Rich wraps at 80 columns; this keeps a piped line, such as a curl command, whole.
_PIPED_WIDTH = 1000

console = Console(width=None if is_terminal(sys.stdout) else _PIPED_WIDTH)
# For notices that are not the command's result, so `--json` output on stdout
# stays a single parseable object.
err_console = Console(
    stderr=True, width=None if is_terminal(sys.stderr) else _PIPED_WIDTH
)


def set_quiet(quiet):
    """Silence every helper here, so `canyonos test --json` emits only its payload."""
    console.quiet = err_console.quiet = quiet


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
    """Show an error message on stderr, marked with a red ✗."""
    _emit(message, "bold red", "✗", err_console)


def root_cause(message):
    """Show the line that explains a failure on stderr, marked with a bright red ✗."""
    err_console.print(Text(f"✗ Root Cause: {message}", style="bold bright_red"))


def warn(message):
    """Show a warning on stderr, marked with a yellow !."""
    _emit(message, "yellow", "!", err_console)


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
    """Show a Rich panel or table in the terminal; hidden when `--json` output is on.
    Piped, it is only as wide as its longest line, so no line wraps."""
    width = None if is_terminal(sys.stdout) else console.measure(renderable).maximum
    console.print(renderable, width=width)


@contextmanager
def status(message):
    """Show a spinner and `message` in the terminal while the `with` block runs.
    Piped, print `message` and each update as a plain line instead."""
    if not is_terminal(sys.stdout):
        say(message)
        yield SimpleNamespace(update=say)
        return
    with console.status(message) as spinner:
        yield spinner
