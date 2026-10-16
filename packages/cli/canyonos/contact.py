# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
Logic for `canyonos contact`: see and change what the CLI shares with Canyon Code.
Today that is only usage reporting, which stays off until you agree to it.
"""

from canyonos import ui
from canyonos.usage.consent import (
    HOW_TO_CHANGE,
    WHAT_IS_SENT,
    ask_usage_reporting,
    is_interactive,
    show_settings,
)
from canyonos.usage.settings import load_settings, set_usage_reporting, usage_dir


def _save(enabled):
    try:
        settings = set_usage_reporting(enabled)
    except OSError as e:
        raise RuntimeError(
            f"Could not save usage settings in {usage_dir()}: {e}"
        ) from None
    show_settings(settings)
    if settings.usage_reporting:
        ui.hint(WHAT_IS_SENT)


def run_contact(usage=None):
    """Run `canyonos contact`: set usage reporting from `--usage on|off`, or show whether
    it is on and, at a terminal, ask whether to change it. Turning it off deletes the
    events not sent yet; turning it back on starts a new installation id."""
    if usage is not None:
        _save(usage == "on")
        return

    show_settings(load_settings())
    if not is_interactive():
        ui.hint("Run `canyonos contact --usage on` or `canyonos contact --usage off`.")
        return

    answer = ask_usage_reporting()
    if answer is None:
        ui.say("Nothing changed.")
        ui.hint(HOW_TO_CHANGE)
        return
    _save(answer)
