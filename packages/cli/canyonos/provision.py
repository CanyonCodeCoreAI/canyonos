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
# The action as `canyonos provision <action>` names it, for the AWS EC2 machine.
ACTIONS = {"aws": PROVISION, "teardown": TEAR_DOWN}
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


AWS_EC2 = Provisioner(
    "AWS EC2 machine",
    "Launch an EC2 machine to deploy from. Agents then run on EC2 too.",
    "Remove a machine you provisioned, with the security group and key pair made "
    "for it.",
    _aws_provision,
)
PROVISIONERS = (
    AWS_EC2,
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


@dataclass(frozen=True)
class Answers:
    """Answers given as flags, so their questions aren't asked. With `yes`, every
    question without one takes its default (see `canyonos provision --help`) and
    nothing is confirmed, so provisioning runs without a terminal: the desktop app
    runs it this way."""

    region: str | None = None
    vpc: str | None = None
    subnet: str | None = None
    # A security group's ID, or "new".
    security_group: str | None = None
    machine_type: str | None = None
    # A key pair's name, or "new".
    key_pair: str | None = None
    # An instance profile's name, "new" for the canyonos-controller role, or "none".
    role: str | None = None
    # Teardown: the Global Controller machine to remove.
    machine: str | None = None
    # Teardown, and a run that stops partway: remove the key pairs made for the machine.
    remove_key_pair: bool = False
    yes: bool = False

    @classmethod
    def from_args(cls, args):
        return cls(
            **{
                name: getattr(args, name, None)
                for name in (
                    "region",
                    "vpc",
                    "subnet",
                    "security_group",
                    "machine_type",
                    "key_pair",
                    "role",
                    "machine",
                )
            },
            remove_key_pair=bool(getattr(args, "remove_key_pair", False)),
            yes=bool(getattr(args, "yes", False) or getattr(args, "json", False)),
        )


def run_provision(args=None):
    """Run `canyonos provision`: provision or tear down. Without an action, asks which,
    and what, in the terminal; `aws` and `teardown` are the AWS EC2 machine's. Questions
    answered by flags are skipped, and with --yes (or --json) none are asked. Returns
    True once that is done, False if it stopped."""
    answers = Answers.from_args(args)
    action = ACTIONS.get(getattr(args, "action", None) or "")
    if answers.yes and action is None:
        ui.fail(
            "Say what to provision: `canyonos provision aws --yes` or "
            "`canyonos provision teardown --yes`."
        )
        return False
    if not answers.yes and not is_interactive():
        ui.fail(
            "`canyonos provision` asks questions, so it needs a terminal. To run it "
            "without one, pass `aws` or `teardown` and --yes."
        )
        return False
    provisioner = AWS_EC2
    if action is None:
        try:
            action, provisioner = _choose(PROVISIONERS)
        except Cancelled:
            ui.say("Nothing provisioned.")
            return False
    module = provisioner.load()
    run = module.provision if action == PROVISION else module.teardown
    return run(answers) if provisioner is AWS_EC2 else run()
