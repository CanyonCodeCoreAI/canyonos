# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""`canyonos deploy` through the installed command: the checks it runs before
anything is built, the workflows' own checked by the Global Controller it starts, and
the record under `~/.canyonos/workflows/` it picks or makes for the workflow group
before them. The folder checks come first, before `--api-key` stores anything: a run
that must stop there points DOCKER_HOST at nothing, so a Docker call would show. The
record is settled before the deploy looks for Docker, so the cases on records run
with no Docker engine and stop at that. `canyonos serve` without a Docker engine stops
at that, after it warns that no key is set."""

from __future__ import annotations

import json
import re
import subprocess
import uuid
from collections.abc import Iterator
from pathlib import Path

import pytest
import yaml

from .harness import (
    CliCase,
    needs_a_runtime,
    runtime_environment,
    workflow_group_record,
)

NO_DOCKER = {"DOCKER_HOST": "unix:///nonexistent.sock"}
# What `canyonos deploy` exits with when it finds no Docker engine.
DOCKER_UNAVAILABLE = 4
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


def _deploy(case: CliCase, *args: str, docker: bool = True, cwd: Path | None = None):
    return case.run_cli(
        ["deploy", *args],
        timeout=300,
        env=runtime_environment() if docker else NO_DOCKER,
        cwd=cwd,
    )


def _deployed_up_to_docker(
    case: CliCase, *args: str, cwd: Path | None = None
) -> subprocess.CompletedProcess[str]:
    """`canyonos deploy` with `args` from `cwd` with no Docker engine, which it gets to
    once it picked or made the workflow group's record; fail unless it stopped there."""
    result = _deploy(case, *args, docker=False, cwd=cwd)
    assert result.returncode == DOCKER_UNAVAILABLE, _said(result)
    return result


def _records(case: CliCase) -> list[str]:
    """The name of each workflow group record in `case`'s home."""
    workflows = case.home / ".canyonos" / "workflows"
    return (
        sorted(path.name for path in workflows.iterdir()) if workflows.is_dir() else []
    )


def _settings(record: Path) -> dict:
    """The workflow group's `workflow_group.yaml` in its record `record`."""
    return yaml.safe_load((record / "workflow_group.yaml").read_text())


def _workflow_paths(record: Path) -> list[str]:
    """The folder of each workflow the record `record` lists."""
    return sorted(entry["path"] for entry in _settings(record)["workflows"].values())


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


def test_deploy_from_inside_a_workflow_folder_names_the_workflow_group_after_it(
    cli_case: CliCase,
):
    folder = cli_case.cwd / "echo"
    _workflow(folder)

    _deployed_up_to_docker(cli_case, ".", cwd=folder)

    record = workflow_group_record(cli_case, folder)
    workflow_group_id = _settings(record)["workflow_group_id"]
    assert record.name == f"echo-{workflow_group_id[:8]}", record
    assert _workflow_paths(record) == [str(folder)]
    assert not (folder / "workflow_group.yaml").exists()


def test_a_workflow_group_is_found_by_its_folders_from_any_folder(cli_case: CliCase):
    """The first deploy copies the `workflow_group.yaml` of the folder it runs from,
    and the `.env` beside it, readable only by you, into a new record named after that
    folder, and leaves both as they were. Every
    later deploy of the same workflow folder finds that record by the folder's path,
    from wherever it runs, and reads the seed no more."""
    group = cli_case.cwd / "shop"
    _workflow(group / "echo")
    seed = group / "workflow_group.yaml"
    seed.write_text("logs: true\n")
    (group / ".env").write_text("REGION=eu-west-1\n")

    _deployed_up_to_docker(cli_case, "echo", cwd=group)

    record = workflow_group_record(cli_case, group)
    settings = _settings(record)
    assert record.name == f"shop-{settings['workflow_group_id'][:8]}", record
    assert settings["logs"] is True, settings
    assert _workflow_paths(record) == [str(group / "echo")]
    assert seed.read_text() == "logs: true\n"
    assert (record / ".env").read_text() == "REGION=eu-west-1\n"
    assert (record / ".env").stat().st_mode & 0o777 == 0o600
    assert (group / ".env").read_text() == "REGION=eu-west-1\n"
    recorded = (record / "workflow_group.yaml").read_text()

    elsewhere = cli_case.cwd / "elsewhere"
    elsewhere.mkdir()
    seed.write_text("logs: false\n")
    _deployed_up_to_docker(cli_case, "../shop/echo", cwd=elsewhere)
    _deployed_up_to_docker(cli_case, ".", cwd=group / "echo")
    again = _deployed_up_to_docker(cli_case, "echo", cwd=group)

    assert _records(cli_case) == [record.name]
    assert (record / "workflow_group.yaml").read_text() == recorded
    assert seed.read_text() == "logs: false\n"
    assert f"{seed} is not read" in _said(again), _said(again)


def test_two_workflow_folders_of_the_same_name_are_two_workflow_groups(
    cli_case: CliCase,
):
    folders = [cli_case.cwd / "testing" / "echo", cli_case.cwd / "production" / "echo"]
    for folder in folders:
        _workflow(folder)
        _deployed_up_to_docker(cli_case, str(folder))

    records = [workflow_group_record(cli_case, folder) for folder in folders]

    assert records[0] != records[1], records
    assert all(re.fullmatch(ECHO, record.name) for record in records), records
    assert [_workflow_paths(record) for record in records] == [
        [str(folder)] for folder in folders
    ]
    assert _records(cli_case) == sorted(record.name for record in records)


def test_deploying_other_folders_as_a_workflow_group_asks_first(cli_case: CliCase):
    """Without a terminal and without --yes, a deploy that would replace a workflow
    group's workflows fails, naming both, and changes nothing; --yes goes on."""
    first, second = cli_case.cwd / "first" / "echo", cli_case.cwd / "second" / "echo"
    for folder in (first, second):
        _workflow(folder)
    _deployed_up_to_docker(cli_case, str(first))
    record = workflow_group_record(cli_case, first)
    recorded = (record / "workflow_group.yaml").read_text()

    refused = _deploy(
        cli_case, "--workflow-group", record.name, str(second), docker=False
    )

    output = _said(refused)
    assert refused.returncode == 1, output
    assert f"This replaces the workflows of {record.name}" in output
    assert f"{first} (stops)" in output and str(second) in output
    assert "Add --yes" in output
    assert (record / "workflow_group.yaml").read_text() == recorded
    assert _records(cli_case) == [record.name]

    workflow_group_id = _settings(record)["workflow_group_id"]
    replaced = _deployed_up_to_docker(
        cli_case, "--workflow-group", workflow_group_id[:8], str(second), "--yes"
    )
    assert "Add --yes" not in _said(replaced), _said(replaced)
    assert _records(cli_case) == [record.name]


def test_deploy_of_a_workflow_group_alone_deploys_its_recorded_folders(
    cli_case: CliCase,
):
    folder = cli_case.cwd / "shop" / "echo"
    _workflow(folder)
    _deployed_up_to_docker(cli_case, str(folder))
    record = workflow_group_record(cli_case, folder)
    (folder / "config" / "workflow_config.yaml").unlink()
    elsewhere = cli_case.cwd / "elsewhere"
    elsewhere.mkdir()

    redeployed = _deploy(
        cli_case, "--workflow-group", record.name, docker=False, cwd=elsewhere
    )
    unnamed = _deploy(cli_case, docker=False, cwd=elsewhere)

    assert redeployed.returncode == 1, _said(redeployed)
    assert f"is {folder} a workflow folder?" in _said(redeployed)
    assert unnamed.returncode == 1, _said(unnamed)
    assert "Name the workflow folders to deploy" in _said(unnamed)


def test_a_workflow_group_is_a_name_the_first_deploy_of_it_makes(cli_case: CliCase):
    """`--workflow-group <name>` with folders makes the workflow group of that name when
    none is recorded, from any folder and whatever the folders are called; later, the
    name alone finds it. A name no workflow group has, given no folders, says how to
    make it."""
    folder = cli_case.cwd / "apps" / "echo"
    _workflow(folder)
    elsewhere = cli_case.cwd / "elsewhere"
    elsewhere.mkdir()

    _deployed_up_to_docker(
        cli_case, str(folder), "--workflow-group", "My Shop", cwd=elsewhere
    )

    record = workflow_group_record(cli_case, folder)
    assert record.name == f"my-shop-{_settings(record)['workflow_group_id'][:8]}"
    assert _workflow_paths(record) == [str(folder)]
    assert not list(elsewhere.iterdir())

    again = _deployed_up_to_docker(
        cli_case, "--workflow-group", "my-shop", cwd=cli_case.cwd
    )
    unknown = _deploy(cli_case, "--workflow-group", "nothing", docker=False)

    assert "This replaces the workflows" not in _said(again), _said(again)
    assert _records(cli_case) == [record.name]
    assert unknown.returncode == 1, _said(unknown)
    assert "No workflow group is named `nothing`" in _said(unknown), _said(unknown)


def test_deploy_moves_an_older_cli_s_records_into_the_workflow_group(
    cli_case: CliCase,
):
    """A workflow group folder an older CLI deployed from: its workflow_group.yaml
    keeps the workflow_group_id and each workflow's, with paths from that folder, and
    its records are under `~/.canyonos/deployments/`. The first deploy from it moves
    them into the new record, with the workflow paths made absolute."""
    group = cli_case.cwd / "shop"
    _workflow(group / "echo")
    workflow_group_id, workflow_id = str(uuid.uuid4()), str(uuid.uuid4())
    workflow = f"echo-{workflow_id[:8]}"
    (group / "workflow_group.yaml").write_text(
        f"workflow_group_id: {workflow_group_id}\n"
        f"workflows:\n  {workflow}:\n    path: echo\n"
        f"    workflow_id: {workflow_id}\n"
    )
    name = f"shop-{workflow_group_id[:8]}"
    legacy = cli_case.home / ".canyonos" / "deployments" / name
    (legacy / "ca").mkdir(parents=True)
    (legacy / "ca" / "ca.pem").write_text("the older CLI's CA")
    state = json.dumps(
        {"container_id": "c0ffee", "workflow_group_id": workflow_group_id}
    )
    (legacy / "state.json").write_text(state)

    _deployed_up_to_docker(cli_case, "echo", cwd=group)

    record = workflow_group_record(cli_case, group)
    assert record.name == name, record
    assert (record / "ca" / "ca.pem").read_text() == "the older CLI's CA"
    assert (record / "state.json").read_text() == state
    assert not legacy.exists()
    settings = _settings(record)
    assert settings["workflow_group_id"] == workflow_group_id, settings
    assert settings["workflows"] == {
        workflow: {"path": str(group / "echo"), "workflow_id": workflow_id}
    }, settings


def test_deploy_of_a_folder_that_is_no_workflow_says_so_before_the_key_is_stored(
    cli_case: CliCase,
):
    result = _deploy(
        cli_case, "nowhere", "--api-key", "deploy-checks-key", docker=False
    )

    output = _said(result)
    assert result.returncode == 1, output
    assert f"is {cli_case.cwd / 'nowhere'} a workflow folder?" in output
    assert not _key_file(cli_case).exists()
    assert _records(cli_case) == []


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
