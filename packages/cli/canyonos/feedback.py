# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
Logic for `canyonos feedback`: send your message to Canyon Code right away, through the
same API as usage reporting. While usage reporting is off it asks first and sends no
installation id.
"""

import platform
import uuid

from canyonos import env, ui
from canyonos.env import USAGE_URL_VAR, VERSION
from canyonos.usage.consent import is_interactive
from canyonos.usage.delivery import post_json
from canyonos.usage.settings import load_settings
from utils.tui import select_menu

FEEDBACK_PATH = "/feedback"
# Must match MAX_FEEDBACK_MESSAGE_LENGTH in packages/cli-usage-api/src/feedback.contract.ts.
MAX_MESSAGE_LENGTH = 4000
WHAT_IS_SENT = [
    "It leaves your machine and is stored by Canyon Code.",
    "It's anonymous: only your text, the CLI version, OS and CPU type.",
    "No installation id, and your IP address isn't saved.",
    "Leave anything personal out of your text.",
]


def _confirm_anonymous_send() -> bool:
    answer = select_menu(
        [(True, "Yes, send it"), (False, "No, don't send")],
        title="Send this feedback to Canyon Code?",
        header=WHAT_IS_SENT,
    )
    return answer is True


def run_feedback(message, yes=False):
    """Run `canyonos feedback`: send `message` with the CLI version, OS and CPU type, plus
    the installation id while usage reporting is on. While it is off, ask at a terminal
    first unless `yes` says the user already agreed, and refuse to send otherwise."""
    if env.usage_url is None:
        raise RuntimeError(
            f"Feedback can't be sent: {USAGE_URL_VAR} is not set to a usable URL."
        )
    if not 0 < len(message) <= MAX_MESSAGE_LENGTH:
        raise RuntimeError(
            f"Feedback must be 1 to {MAX_MESSAGE_LENGTH} characters; yours is {len(message)}."
        )

    settings = load_settings()
    reporting = settings is not None and settings.usage_reporting
    if not reporting and not yes:
        if not is_interactive():
            raise RuntimeError(
                "Usage reporting is off, so feedback asks before sending. Run it in a "
                "terminal, or add --yes to send it anonymously."
            )
        if not _confirm_anonymous_send():
            ui.say("Nothing was sent.")
            return

    feedback = {
        "feedback_id": str(uuid.uuid4()),
        "message": message,
        "cli_version": VERSION,
        "os": platform.system(),
        "arch": platform.machine(),
    }
    if reporting:
        feedback["installation_id"] = settings.installation_id
    if not post_json(env.usage_url + FEEDBACK_PATH, feedback):
        raise RuntimeError("Could not send your feedback. Try again later.")
    ui.ok("Thanks, your feedback was sent.")
