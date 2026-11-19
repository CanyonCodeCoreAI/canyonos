# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""`canyonos deploy` through the installed command: the checks it runs before
anything is built, from a workflow group folder or from inside a workflow folder, the
workflows' own checked by the Global Controller it starts. The folder checks come
first, before `--api-key` stores anything: a run that must stop there points
DOCKER_HOST at nothing, so a Docker call would show. `canyonos serve` without a Docker
engine stops at that, after it warns that no key is set."""

from __future__ import annotations

import json
import re
import subprocess
import uuid
from collections.abc import Iterator
from pathlib import Path

import pytest

from .harness import CliCase, needs_a_runtime, runtime_environment

NO_DOCKER = {"DOCKER_HOST": "unix:///nonexistent.sock"}
ECHO = "echo-[0-9a-f]{8}"
SCHEMA_ERROR = rf"CANYON-SCHEMA {ECHO}/config/workflow_config\.yaml:1"
STOPPED = "Fix the workflow errors"
OPEN_WARNING = (
    "No API key is set: the endpoint and the dashboard answer anyone who reaches "
    "them. Set one with --api-key <key>."
)


@pytest.fixture(autouse=True)
def _stop_what_the_deploy_started(cli_case: CliCase) -> Iterator[None]:
    """A deploy brings up this machine's CanyonOS API, which outlives the case's home;
    stop it and what it runs, so the next case finds no API but its own."""
    yield
    if (cli_case.home / ".canyonos" / "dashboard" / ".env").exists():
        cli_case.run_cli(["stop", "--all"], timeout=300, env=runtime_environment())


def _said(result: subprocess.CompletedProcess[str]) -> str:
    return " ".join((result.stdout + result.stderr).split())


def _workflow(folder: Path) -> None:
    """Write a workflow whose manifest names code it does not hold into `folder`."""
    (folder / "config").mkdir(parents=True)
    (folder / "config" / "workflow_config.yaml").write_text(
        "agents:\n  - name: Echo\n    entrypoint: agents/missing.py\n"
    )


def _broken_workflow(case: CliCase) -> None:
    _workflow(case.cwd / "echo")
    (case.cwd / "echo" / ".env.example").write_text("API_KEY=\n# OPTIONAL_KEY=\n")


def _key_file(case: CliCase) -> Path:
    return case.home / ".canyonos" / "api_key"


def _deploy(case: CliCase, *args: str, docker: bool = True):
    return case.run_cli(
        ["deploy", *args],
        timeout=300,
        env=runtime_environment() if docker else NO_DOCKER,
    )


def _assert_reached_the_schema_check(result: subprocess.CompletedProcess[str]) -> None:
    output = _said(result)
    assert result.returncode == 1, output
    assert re.search(rf"Missing or empty in {ECHO}/\.env: API_KEY\. Agents", output)
    assert re.search(SCHEMA_ERROR, output)
    assert STOPPED in output


@needs_a_runtime
def test_deploy_warns_about_unset_keys_and_stops_on_workflow_errors(cli_case: CliCase):
    _broken_workflow(cli_case)

    result = _deploy(cli_case, "echo")

    _assert_reached_the_schema_check(result)
    assert "OPTIONAL_KEY" not in _said(result)

    as_json = _deploy(cli_case, "echo", "--json")
    assert json.loads(as_json.stdout)["code"] == "workflow_invalid", as_json.stdout


@needs_a_runtime
def test_deploy_without_an_api_key_warns_and_goes_on(cli_case: CliCase):
    _broken_workflow(cli_case)

    result = _deploy(cli_case, "echo")

    _assert_reached_the_schema_check(result)
    errors = " ".join(result.stderr.split())
    assert OPEN_WARNING in errors
    assert errors.index(OPEN_WARNING) < errors.index(STOPPED), errors


@needs_a_runtime
def test_deploy_with_an_api_key_stores_it_before_the_workflow_checks(
    cli_case: CliCase,
):
    _broken_workflow(cli_case)

    result = _deploy(cli_case, "echo", "--api-key", "deploy-checks-key")

    _assert_reached_the_schema_check(result)
    assert OPEN_WARNING not in _said(result)
    assert _key_file(cli_case).read_text().strip() == "deploy-checks-key"


def test_deploy_from_inside_a_workflow_folder_is_refused(cli_case: CliCase):
    _workflow(cli_case.cwd)

    result = _deploy(cli_case, ".", "--api-key", "deploy-checks-key", docker=False)

    output = _said(result)
    assert result.returncode == 1, output
    assert (
        "This folder is a workflow. Give the workflow group a folder of its own"
        in output
    )
    assert not (cli_case.cwd / "workflow_group.yaml").exists()
    assert not _key_file(cli_case).exists()


def test_deploy_of_a_folder_that_is_no_workflow_says_so_before_the_key_is_stored(
    cli_case: CliCase,
):
    result = _deploy(
        cli_case, "nowhere", "--api-key", "deploy-checks-key", docker=False
    )

    output = _said(result)
    assert result.returncode == 1, output
    assert "is nowhere a workflow folder?" in output
    assert not _key_file(cli_case).exists()


def test_deploy_refuses_a_workflow_group_id_that_is_not_a_lowercase_uuid(
    cli_case: CliCase,
):
    _broken_workflow(cli_case)
    deployment_id = str(uuid.uuid4()).upper()
    (cli_case.cwd / "workflow_group.yaml").write_text(
        f"workflow_group_id: {deployment_id}\n"
    )

    result = _deploy(cli_case, "echo", docker=False)

    output = _said(result)
    assert result.returncode == 1, output
    assert f"workflow_group_id '{deployment_id}'" in output
    assert "lowercase, hyphenated UUID" in output
    assert "Docker" not in output


def test_serve_without_a_docker_engine_warns_of_no_key_and_stops(cli_case: CliCase):
    result = cli_case.run_cli(["serve"], timeout=60, env=NO_DOCKER)

    output = _said(result)
    assert result.returncode == 1, output
    assert OPEN_WARNING in output
    assert "docker daemon or socket is unavailable" in output
