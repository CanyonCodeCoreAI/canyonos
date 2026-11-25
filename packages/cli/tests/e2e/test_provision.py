# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""`canyonos provision` through the installed command. On a terminal, through its menus
up to the AWS sign-in every AWS provisioner starts with, where it is cancelled. Without
one, as the desktop app runs it: an action and --yes (or --json) ask nothing, and AWS is
an endpoint that answers nothing. Either way no case can create anything in an AWS
account."""

from __future__ import annotations

import json
import os
import re
import socket
import subprocess
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


def _closed_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def _no_aws() -> dict[str, str]:
    """Credentials AWS would refuse, sent to an endpoint that answers nothing."""
    return {
        "AWS_ACCESS_KEY_ID": "e2e",
        "AWS_SECRET_ACCESS_KEY": "e2e",
        "AWS_DEFAULT_REGION": "us-east-1",
        "AWS_ENDPOINT_URL": f"http://127.0.0.1:{_closed_port()}",
        "AWS_MAX_ATTEMPTS": "1",
    }


def _said(result: subprocess.CompletedProcess[str]) -> str:
    return " ".join((result.stdout + result.stderr).split())


def test_provision_without_a_terminal_says_how_to_run_it_without_one(
    cli_case: CliCase,
):
    result = cli_case.run_cli(["provision", "aws"])

    assert result.returncode != 0, _said(result)
    assert "pass `aws` or `teardown` and --yes" in _said(result)


def test_provision_json_without_an_action_fails_and_names_both(cli_case: CliCase):
    result = cli_case.run_cli(["provision", "--json"])

    assert result.returncode != 0, _said(result)
    answer = json.loads(result.stdout)
    assert answer["ok"] is False
    assert "provision aws --yes" in answer["errors"][0]
    assert "provision teardown --yes" in answer["errors"][0]


def test_provision_json_asks_nothing_and_reports_refused_credentials(
    cli_case: CliCase,
):
    result = cli_case.run_cli(["provision", "aws", "--json"], env=_no_aws(), timeout=60)

    assert result.returncode != 0, _said(result)
    answer = json.loads(result.stdout)
    assert answer["ok"] is False
    assert "AWS did not accept your default credentials" in answer["errors"][0]
    assert not (cli_case.home / ".ssh").exists()


def test_teardown_json_asks_nothing_and_reports_refused_credentials(
    cli_case: CliCase,
):
    result = cli_case.run_cli(
        ["provision", "teardown", "--yes", "--json", "--region", "us-east-1"],
        env=_no_aws(),
        timeout=60,
    )

    assert result.returncode != 0, _said(result)
    answer = json.loads(result.stdout)
    assert answer["ok"] is False
    assert "AWS did not accept your default credentials" in answer["errors"][0]
