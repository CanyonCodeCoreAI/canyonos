# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
Logic for `canyonos provision`: make something in a cloud account to deploy with, or
tear down what it made. Each thing it can make has a provisioner: a module whose
`provision()` and `teardown()` walk through it in the terminal and return True once it
is done, False if it stopped. The prompts every walk-through asks with are here too.
"""

from dataclasses import dataclass
from types import ModuleType
from typing import Callable

from canyonos import ui
from canyonos.usage.consent import is_interactive
from utils.tui import input_line, select_menu

PROVISION = "provision"
TEAR_DOWN = "teardown"
# The tags on everything provisioning makes: what made it, and the provision ID of the
# run, so teardown removes exactly what that run made.
CREATED_BY = "canyonos provision"
PROVISION_ID_TAG = "canyonos-provision"


class Cancelled(Exception):
    """You backed out of a menu or prompt."""


def numbered(entries):
    """Turn (value, title, detail) entries into menu options labelled `1. title`, with
    the detail, if any, on the line under it."""
    return [
        (value, f"{n}. {title}" + (f"\n   {detail}" if detail else ""))
        for n, (value, title, detail) in enumerate(entries, 1)
    ]


def pick(entries, title):
    """The value of the (value, title, detail) entry you choose. Raises Cancelled when
    you back out."""
    choice = select_menu(numbered(entries), title)
    if choice is None:
        raise Cancelled
    return choice


def ask(prompt):
    """A line you type, asked again while it is empty. Raises Cancelled when you back
    out."""
    while True:
        value = input_line(prompt, hint="enter next · esc back")
        if value is None:
            raise Cancelled
        if value:
            return value


@dataclass(frozen=True)
class Provisioner:
    title: str
    # What provisioning makes, and what tearing down removes.
    provision_detail: str
    teardown_detail: str
    # Returns the module with provision() and teardown(), imported only once it is
    # chosen, so other commands never load a cloud's libraries.
    load: Callable[[], ModuleType]


# Imported by name, not by a string, so the release build (Nuitka) bundles them.
def _aws_provision():
    from canyonos import aws_provision

    return aws_provision


def _rosa_provision():
    from canyonos import rosa_provision

    return rosa_provision


PROVISIONERS = (
    Provisioner(
        "AWS EC2 machine",
        "Launch an EC2 machine to deploy from. Agents then run on EC2 too.",
        "Remove a machine you provisioned, with the security group and key pair made "
        "for it.",
        _aws_provision,
    ),
    Provisioner(
        "Red Hat OpenShift on AWS (ROSA) cluster",
        "Make a ROSA cluster with CanyonOS on it, in a VPC of its own, and point "
        "kubectl at it.",
        "Delete a ROSA cluster you provisioned from this machine, with its workflows, "
        "VPC and IAM roles.",
        _rosa_provision,
    ),
)


def _choose(provisioners):
    """Ask whether to provision or tear down, and, when there is more than one
    provisioner, which. Returns (action, provisioner)."""
    only = provisioners[0] if len(provisioners) == 1 else None
    action = pick(
        [
            (
                PROVISION,
                "Provision",
                only.provision_detail
                if only
                else "Make a machine or cluster to deploy with.",
            ),
            (
                TEAR_DOWN,
                "Tear down",
                only.teardown_detail
                if only
                else "Remove one you provisioned, with what was made for it.",
            ),
        ],
        "What do you want to do?",
    )
    if only:
        return action, only
    provisioner = pick(
        [
            (
                provisioner,
                provisioner.title,
                provisioner.provision_detail
                if action == PROVISION
                else provisioner.teardown_detail,
            )
            for provisioner in provisioners
        ],
        "What should be provisioned?"
        if action == PROVISION
        else "What should be torn down?",
    )
    return action, provisioner


def run_provision():
    """Run `canyonos provision`: ask whether to provision or tear down, and what, then
    walk through it in the terminal. Returns True once that is done, False if it
    stopped."""
    if not is_interactive():
        ui.fail("`canyonos provision` asks questions, so it needs a terminal.")
        return False
    try:
        action, provisioner = _choose(PROVISIONERS)
    except Cancelled:
        ui.say("Nothing provisioned.")
        return False
    module = provisioner.load()
    return module.provision() if action == PROVISION else module.teardown()
