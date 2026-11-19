# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""`canyonos curl` through the installed command, each case in its own HOME: what it
refuses before it sends anything. The live call against a deployed workflow is in
`tests/e2e/cases/test_1_cli.py`."""

from __future__ import annotations

import subprocess

from .harness import CliCase


def _said(result: subprocess.CompletedProcess[str]) -> str:
    return " ".join((result.stdout + result.stderr).split())


def test_curl_without_a_selected_workflow_group_says_how_to_pick_one(
    cli_case: CliCase,
):
    result = cli_case.run_cli(["curl", '{"query": "World"}'])

    output = _said(result)
    assert result.returncode == 1, output
    assert "No workflow group is selected" in output, output
    assert "canyonos list" in output, output
    assert "canyonos select-context <workflow group>" in output, output
    assert "Traceback" not in result.stderr, result.stderr


def test_curl_refuses_a_body_that_is_not_json(cli_case: CliCase):
    result = cli_case.run_cli(["curl", "{query: World}"])

    output = _said(result)
    assert result.returncode == 1, output
    assert "The body is not valid JSON" in output, output
    assert """canyonos curl '{"query": "hello"}'""" in output, output
    assert "Traceback" not in result.stderr, result.stderr


def test_curl_help_names_the_body_and_its_options(cli_case: CliCase):
    result = cli_case.run_cli(["curl", "-h"])

    output = _said(result)
    assert result.returncode == 0, output
    assert "usage: canyonos curl" in output, output
    assert "JSON" in output, output
    assert "--route WORKFLOW/AGENT/METHOD" in output, output
    assert "--print" in output, output
