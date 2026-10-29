# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
Logic for `canyonos provision`: provision a machine in a cloud account that is ready to
run `canyonos deploy` as the Global Controller, or tear down one it provisioned. AWS is
the only cloud so far.
"""

from canyonos import ui
from canyonos.usage.consent import is_interactive
from utils.tui import select_menu

AWS = "aws"
TEARDOWN_AWS = "teardown_aws"

MENU = [
    (
        AWS,
        "1. Provision AWS\n   Launch an EC2 machine to deploy from. Agents then run on EC2 too.",
    ),
    (
        TEARDOWN_AWS,
        "2. Tear down AWS\n   Remove a machine you provisioned, with the security group "
        "and key pair made for it.",
    ),
]


def run_provision():
    """Run `canyonos provision`: ask whether to provision AWS or tear down a machine
    provisioned there, then walk through it in the terminal. Returns True once that is
    done, False if it stopped."""
    if not is_interactive():
        ui.fail("`canyonos provision` asks questions, so it needs a terminal.")
        return False
    choice = select_menu(MENU, "What do you want to do?")
    if choice is None:
        ui.say("Nothing provisioned.")
        return False
    # Imported here so other commands never load boto3.
    from canyonos.aws_provision import run_aws_provision, run_aws_teardown

    return run_aws_teardown() if choice == TEARDOWN_AWS else run_aws_provision()
