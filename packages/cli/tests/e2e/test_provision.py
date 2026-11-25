# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""`canyonos provision` on a terminal, through its menus up to the AWS sign-in every
AWS provisioner starts with, where it is cancelled: nothing reaches AWS."""

from __future__ import annotations

import os
import re
from pathlib import Path

import pexpect
import pytest

from .harness import CliCase

ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
ACTION_MENU = "What do you want to do?"
PROVISIONER_MENU = re.compile(r"What should be (provisioned|torn down)\?")
CREDENTIALS_MENU = "Which AWS credentials should provisioning use?"
ESC = "\x1b"
PROVISION, TEAR_DOWN = "1", "2"
EC2, ROSA = "1", "2"


def _path_with_kubectl(folder: Path) -> str:
    """PATH with a stand-in kubectl first: a cluster provisioner checks kubectl is
    installed before it signs in."""
    kubectl = folder / "kubectl"
    kubectl.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    kubectl.chmod(0o755)
    return f"{folder}{os.pathsep}{os.environ.get('PATH', '')}"


def _run(
    case: CliCase,
    action: str,
    provisioner: str,
    *,
    cancel_at_sign_in=True,
    path: str | None = None,
):
    """Choose `action` and `provisioner` from the menus, then back out of the AWS
    sign-in, if asked. Returns what the command showed, without colors, and its exit
    status."""
    terminal = case.spawn_cli(
        ["provision"], timeout=30, env={"PATH": path} if path else None
    )
    child = terminal.child
    child.expect_exact(ACTION_MENU)
    child.send(action)
    child.expect(PROVISIONER_MENU)
    child.send(provisioner)
    if cancel_at_sign_in:
        child.expect_exact(CREDENTIALS_MENU)
        child.send(ESC)
    child.expect(pexpect.EOF)
    shown = child.before
    child.close()
    return " ".join(ANSI.sub("", shown).split()), child.exitstatus


@pytest.mark.parametrize(
    ("action", "provisioner", "stopped"),
    [
        (PROVISION, EC2, "Provisioning stopped."),
        (TEAR_DOWN, EC2, "Nothing removed."),
        (PROVISION, ROSA, "Provisioning stopped."),
    ],
    ids=["provision-ec2", "tear-down-ec2", "provision-rosa"],
)
def test_provision_reaches_the_aws_sign_in_and_cancels(
    cli_case: CliCase, tmp_path: Path, action: str, provisioner: str, stopped: str
):
    shown, status = _run(
        cli_case, action, provisioner, path=_path_with_kubectl(tmp_path)
    )

    assert stopped in shown, shown
    assert status == 1, shown


def test_provisioning_a_cluster_without_kubectl_fails_before_signing_in(
    cli_case: CliCase, tmp_path: Path
):
    shown, status = _run(
        cli_case, PROVISION, ROSA, cancel_at_sign_in=False, path=str(tmp_path)
    )

    assert "kubectl is not installed" in shown, shown
    assert CREDENTIALS_MENU not in shown, shown
    assert status == 1, shown


def test_tearing_down_rosa_with_no_cluster_provisioned_says_so(cli_case: CliCase):
    shown, status = _run(cli_case, TEAR_DOWN, ROSA, cancel_at_sign_in=False)

    assert "No ROSA clusters were provisioned from this machine." in shown, shown
    assert status == 0, shown


def test_provision_without_a_terminal_fails(cli_case: CliCase):
    result = cli_case.run_cli(["provision"])

    assert result.returncode == 1, result.stdout
    assert "needs a terminal" in result.stdout + result.stderr, result.stdout
