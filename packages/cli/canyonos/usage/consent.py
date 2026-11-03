# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
Usage reporting is on by default. Before the first event is recorded, the CLI shows a
notice in the terminal saying what is sent and how to turn it off. That event waits for
the next `canyonos` run, so turning reporting off right away sends nothing; `canyonos
contact` shows or changes the choice afterwards.
"""

import sys

from rich.text import Text

from canyonos import ui
from canyonos.os_support import is_terminal
from canyonos.usage.settings import UsageSettings
from utils.tui import select_menu

DOCS_URL = (
    "https://github.com/CanyonCodeCoreAI/canyonos/blob/main/docs/guides/CLI.md"
    "#usage-reporting"
)
DISABLE_COMMAND = "canyonos contact --usage off"
WHAT_IS_SENT = (
    "Sent: the command name, whether it succeeded, when it ran, the CLI version and "
    "a random installation id."
)
WHAT_IS_NEVER_SENT = (
    "Never sent: your arguments, paths, prompts, code, environment variables or "
    "credentials."
)
HOW_TO_CHANGE = "Change this any time with `canyonos contact`."


def is_interactive() -> bool:
    """Whether someone is at a terminal to answer: stdin, stdout and stderr (where the
    menu draws) are all attached to one."""
    return (
        is_terminal(sys.stdin) and is_terminal(sys.stdout) and is_terminal(sys.stderr)
    )


def show_first_event_notice(command: str) -> None:
    """Tell the user on stderr, before the first usage event is recorded, that usage
    for the `command` that just finished will be sent with their next `canyonos`
    command: what is and isn't sent, where the full list is, and how to turn it off
    before anything leaves the machine. stderr keeps `--json` output parseable."""
    ui.err_console.print()
    ui.err_console.print(
        Text(
            f"! CanyonOS shares anonymous usage: the `{command}` run that just "
            "finished will be sent to Canyon Code with your next `canyonos` command. "
            "No sensitive information is sent.",
            style="yellow",
        ),
        soft_wrap=True,
    )
    for detail in (
        WHAT_IS_SENT,
        WHAT_IS_NEVER_SENT,
        f"Details: {DOCS_URL}",
        f"Turn it off before anything is sent: {DISABLE_COMMAND}",
    ):
        ui.err_console.print(Text(f"  {detail}", style="dim"), soft_wrap=True)


def ask_usage_reporting() -> bool | None:
    """Explain in the terminal what usage reporting sends and ask whether it should be
    on. Return the answer, or None if the question was dismissed with Esc or Ctrl-C."""
    ui.blank()
    ui.say("Help improve CanyonOS by sharing how you use the CLI?")
    ui.hint(WHAT_IS_SENT)
    ui.hint(WHAT_IS_NEVER_SENT)
    ui.hint(f"Details: {DOCS_URL}")
    return select_menu(
        [(True, "Yes, share usage"), (False, "No, don't share")],
        title="Share CLI usage with Canyon Code?",
    )


def show_settings(settings: UsageSettings | None) -> None:
    """Show in the terminal whether usage reporting is on and under which id."""
    if settings is None:
        ui.say("Usage reporting is on by default. Nothing has been sent yet.")
    elif settings.usage_reporting:
        ui.ok(f"Usage reporting is on (installation id {settings.installation_id}).")
    else:
        ui.say("Usage reporting is off.")
