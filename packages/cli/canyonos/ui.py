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
from rich.prompt import Prompt
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


def heading(message):
    """Show a section heading in the terminal, in bold.

    The weight is what makes a section findable when scrolling back through
    the screen or more that a deploy or a checklist prints under it.
    """
    _emit(message, f"bold {GREEN}")


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


def ask(question, default="", suffix=": "):
    """Read one line of typed text from the terminal.

    Returns `default` without asking when there is no terminal to read from, so
    a piped run falls through instead of blocking forever on stdin, and so does
    an end of input -- Ctrl-D is an answer, not a crash.

    The default is never shown. Rich would print it in brackets after the
    question, which for the empty default here is a bare `()` -- a thing on
    screen that means nothing to the person reading it.
    """
    if not sys.stdin.isatty():
        return default
    prompt = Prompt(
        Text(str(question), style=GREEN), console=console, show_default=False
    )
    prompt.prompt_suffix = suffix
    try:
        return prompt(default=default).strip()
    except EOFError:
        return default


def secret(question):
    """Ask for a value that must not be echoed, such as an API key.

    Returns "" without asking when there is no terminal to read from. Callers
    reject an empty value anyway, so a piped run fails saying which key it
    needed rather than hanging on stdin.
    """
    if not sys.stdin.isatty():
        return ""
    return Prompt.ask(
        Text(str(question), style=WHITE), console=console, password=True
    ).strip()


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
