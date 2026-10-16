# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
The one usage reporting question the CLI asks: once, after your first deploy that comes
up in a terminal, and again whenever you run `canyonos contact` without flags.
"""

import sys

from canyonos import ui
from canyonos.usage.settings import UsageSettings, load_settings, set_usage_reporting
from utils.tui import select_menu

WHAT_IS_SENT = (
    "Usage reporting sends Canyon Code only the command name, whether the command "
    "succeeded, when it ran, the CLI version and a random installation id. Never your "
    "arguments, paths, prompts, code, environment or credentials."
)
HOW_TO_CHANGE = "Change this any time with `canyonos contact`."


def is_interactive() -> bool:
    """Whether someone is at a terminal to answer: stdin, stdout and stderr (where the
    menu draws) are all attached to one."""
    return sys.stdin.isatty() and sys.stdout.isatty() and sys.stderr.isatty()


def ask_usage_reporting() -> bool | None:
    """Explain in the terminal what usage reporting sends and ask whether to turn it on.
    Return the answer, or None if the question was dismissed with Esc or Ctrl-C."""
    ui.blank()
    ui.say("Help improve CanyonOS by sharing how you use the CLI?")
    ui.hint(WHAT_IS_SENT)
    ui.hint(HOW_TO_CHANGE)
    return select_menu(
        [(True, "Yes, share usage"), (False, "No, don't share")],
        title="Share CLI usage with Canyon Code?",
    )


def show_settings(settings: UsageSettings | None) -> None:
    """Show in the terminal whether usage reporting is on and under which id."""
    if settings is None:
        ui.say("Usage reporting is off. You haven't been asked yet.")
    elif settings.usage_reporting:
        ui.ok(f"Usage reporting is on (installation id {settings.installation_id}).")
    else:
        ui.say("Usage reporting is off.")


def offer_after_first_deploy() -> None:
    """Ask the usage reporting question once `canyonos deploy` has brought the workflow
    up, unless nobody is at a terminal or it was already answered. Dismissing it counts
    as no. A choice that can't be saved shows a warning instead of failing the deploy."""
    if not is_interactive() or load_settings() is not None:
        return
    try:
        answer = ask_usage_reporting()
        settings = set_usage_reporting(bool(answer))
    except KeyboardInterrupt:
        ui.blank()
        return
    # The workflow is already up: nothing here may turn that into a failed deploy.
    except Exception as e:
        ui.warn(f"Could not save your usage reporting choice: {e}")
        ui.hint(HOW_TO_CHANGE)
        return
    show_settings(settings)
    ui.hint(HOW_TO_CHANGE)
