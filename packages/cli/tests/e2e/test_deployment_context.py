# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""`canyonos list`, `canyonos select-context`, `canyonos clean` and the commands that act
on the workflow group of the folder they run from or on the selected one, through the
installed command, each case in its own HOME. The workflow groups are records
`canyonos deploy` would write under `~/.canyonos/workflows/`, whose Global Controller
container is on no Docker engine, and the CanyonOS API that would say whether they run
is on a port that answers nothing; a command that would start that API runs with
DOCKER_HOST pointing at nothing, so no Docker is needed and none is started.
`canyonos dashboard` finds the dashboard through a stand-in `docker` that reports its
web container's port, and prints the link it would open."""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
from pathlib import Path
from urllib.parse import quote, urlsplit


from .harness import CliCase

NO_DOCKER = {"DOCKER_HOST": "unix:///nonexistent.sock"}

API_DOWN = "Could not reach the CanyonOS API"
FIRST_ID = "8a3f6c1e-2b4d-4e5f-9a7b-1c2d3e4f5a6b"
SECOND_ID = "0f9e8d7c-6b5a-4c3d-8e2f-1a0b9c8d7e6f"
THIRD_ID = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f"
PICK_AGAIN = "`canyonos select-context <workflow group>`"
DASHBOARD_PORT = 8095
# Characters a URL fragment has to escape, so the link proves the key is encoded.
API_KEY = "e2e key/with+chars&=#%"
FAKE_DOCKER = f"""#!/bin/sh
if [ "$1 $2 $3" = "container inspect canyonos-dashboard-web" ]; then
  echo '[{{"NetworkSettings": {{"Ports": {{"8080/tcp": [{{"HostIp": "127.0.0.1", "HostPort": "{DASHBOARD_PORT}"}}]}}}}}}]'
  exit 0
fi
exit 1
"""


def _said(result: subprocess.CompletedProcess[str]) -> str:
    return " ".join((result.stdout + result.stderr).split())


def _closed_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def _api_down(case: CliCase) -> str:
    """Put the CanyonOS API of `case` on a port nothing answers on, as the CLI finds
    it when no API runs, and return its URL."""
    ports = case.home / ".canyonos" / "dashboard" / "ports.json"
    if not ports.exists():
        ports.parent.mkdir(parents=True, exist_ok=True)
        ports.write_text(json.dumps({"api": _closed_port()}))
    return f"http://127.0.0.1:{json.loads(ports.read_text())['api']}"


def _record(
    case: CliCase,
    folder: str,
    deployment_id: str,
    auth_disabled: bool = False,
    deployed: bool = True,
) -> str:
    """Write the workflow folder `folder` and the record a deploy of it leaves, with no
    CanyonOS API running, and return the workflow group's name. Without `deployed`,
    the record is one of a workflow group that is not deployed: it has no state."""
    _api_down(case)
    directory = case.cwd / folder
    (directory / "config").mkdir(parents=True)
    name = f"{folder}-{deployment_id[:8]}"
    record = _record_dir(case, name)
    record.mkdir(parents=True)
    workflow_id = "5a30382f-8890-44dc-80f4-bef8f59f9181"
    (record / "workflow_group.yaml").write_text(
        f"workflow_group_id: {deployment_id}\n"
        f"workflows:\n  {folder}-{workflow_id[:8]}:\n    path: {directory}\n"
        f"    workflow_id: {workflow_id}\n"
    )
    if deployed:
        (record / "state.json").write_text(
            json.dumps(
                {
                    "container_id": f"{folder}-controller",
                    "workflow_group_id": deployment_id,
                    "auth_disabled": auth_disabled,
                }
            )
        )
    return name


def _record_dir(case: CliCase, name: str) -> Path:
    return case.home / ".canyonos" / "workflows" / name


def _outside(case: CliCase) -> Path:
    folder = case.cwd / "outside"
    folder.mkdir(exist_ok=True)
    return folder


def _with_a_running_dashboard(case: CliCase) -> dict[str, str]:
    """The environment that puts a `docker` on PATH which reports the dashboard's web
    container on DASHBOARD_PORT and no other container."""
    bin_dir = case.root / "bin"
    bin_dir.mkdir(exist_ok=True)
    docker = bin_dir / "docker"
    docker.write_text(FAKE_DOCKER)
    docker.chmod(0o755)
    return {"PATH": f"{bin_dir}{os.pathsep}{case.env['PATH']}"}


def test_list_with_no_deployment_says_how_to_deploy(cli_case: CliCase):
    result = cli_case.run_cli(["list"])

    assert result.returncode == 0, _said(result)
    assert "No workflow group on this machine" in _said(result)
    assert "canyonos deploy" in _said(result)


def test_list_shows_each_deployment_and_marks_one_deployed_without_an_api_key(
    cli_case: CliCase,
):
    first = _record(cli_case, "app-abcz", FIRST_ID)
    second = _record(cli_case, "app-xyza", SECOND_ID, auth_disabled=True)
    third = _record(cli_case, "app-qrst", THIRD_ID, deployed=False)

    result = cli_case.run_cli(["list"])

    assert result.returncode == 0, _said(result)
    lines = {line.split()[1]: line for line in result.stdout.splitlines()}
    assert set(lines) == {first, second, third}, result.stdout
    assert FIRST_ID in lines[first] and SECOND_ID in lines[second], result.stdout
    assert THIRD_ID in lines[third] and "not deployed" in lines[third], result.stdout
    assert "unknown (API down)" in lines[first], result.stdout
    assert "(unauthenticated)" in lines[second], result.stdout
    assert "(unauthenticated)" not in lines[first], result.stdout
    assert "(selected)" not in result.stdout, result.stdout


def test_list_json_gives_each_workflow_group_with_its_workflow_folders(
    cli_case: CliCase,
):
    first = _record(cli_case, "app-abcz", FIRST_ID)
    second = _record(cli_case, "app-qrst", SECOND_ID, deployed=False)

    result = cli_case.run_cli(["list", "--json"])

    assert result.returncode == 0, _said(result)
    listed = json.loads(result.stdout)
    groups = {group["name"]: group for group in listed["workflow_groups"]}
    assert set(groups) == {first, second}, result.stdout
    assert listed["selected"] is None
    assert groups[first]["workflow_group_id"] == FIRST_ID
    assert groups[first]["deployed"] is True
    assert groups[first]["running"] == "unknown"
    assert groups[second]["deployed"] is False and groups[second]["running"] is None
    assert groups[first]["target"] == "docker"
    [workflow] = groups[first]["workflows"]
    assert workflow["path"] == str((cli_case.cwd / "app-abcz").resolve())
    assert workflow["workflow_id"]
    assert listed["records_dir"] == str(cli_case.home / ".canyonos" / "workflows")
    assert groups[first]["record"] == str(_record_dir(cli_case, first))


def test_list_json_without_status_does_not_ask_the_api(cli_case: CliCase):
    """`list --json --no-status` lists a deployed workflow group as `unchecked` rather
    than asking the CanyonOS API, which `_record` leaves down (`unknown` otherwise)."""
    first = _record(cli_case, "app-abcz", FIRST_ID)
    second = _record(cli_case, "app-qrst", SECOND_ID, deployed=False)

    result = cli_case.run_cli(["list", "--json", "--no-status"])

    assert result.returncode == 0, _said(result)
    groups = {g["name"]: g for g in json.loads(result.stdout)["workflow_groups"]}
    assert groups[first]["running"] == "unchecked", result.stdout
    assert groups[second]["running"] is None, result.stdout


def test_select_context_takes_the_forms_stop_takes_and_list_marks_it(
    cli_case: CliCase,
):
    first = _record(cli_case, "app-abcz", FIRST_ID)
    second = _record(cli_case, "app-xyza", SECOND_ID)

    for ref, picked in ((FIRST_ID[:6], first), (SECOND_ID, second), (first, first)):
        selected = cli_case.run_cli(["select-context", ref], cwd=_outside(cli_case))
        assert selected.returncode == 0, _said(selected)
        listed = cli_case.run_cli(["list"]).stdout
        marked = [line for line in listed.splitlines() if "(selected)" in line]
        assert len(marked) == 1 and picked in marked[0], listed
    context = json.loads((cli_case.home / ".canyonos" / "context.json").read_text())
    assert context == {"deployment": first}


def test_select_context_refuses_a_deployment_it_cannot_tell(cli_case: CliCase):
    _record(cli_case, "app-abcz", FIRST_ID)

    missing = cli_case.run_cli(["select-context", "nope"])
    unnamed = cli_case.run_cli(["select-context"])

    assert missing.returncode == 1, _said(missing)
    assert "No workflow group is named `nope`" in _said(missing)
    assert "canyonos list" in _said(missing)
    assert unnamed.returncode == 1, _said(unnamed)
    assert "--clear" in _said(unnamed)
    assert not (cli_case.home / ".canyonos" / "context.json").exists()


def test_a_command_outside_a_deployment_folder_runs_from_the_selected_one(
    cli_case: CliCase,
):
    name = _record(cli_case, "app-abcz", FIRST_ID)
    assert cli_case.run_cli(["select-context", name]).returncode == 0

    result = cli_case.run_cli(["status"], cwd=_outside(cli_case))

    assert result.returncode == 1, _said(result)
    assert f"Acting on {name}" in result.stderr, _said(result)
    assert API_DOWN in result.stderr, _said(result)


def test_status_without_the_canyonos_api_fails_and_names_it(cli_case: CliCase):
    _record(cli_case, "app-abcz", FIRST_ID)
    api_url = _api_down(cli_case)

    result = cli_case.run_cli(["status"], cwd=cli_case.cwd / "app-abcz")

    assert result.returncode == 1, _said(result)
    assert f"{API_DOWN} at {api_url}" in _said(result)
    assert "canyonos serve" in _said(result)
    assert "Traceback" not in result.stderr, result.stderr


def test_curl_outside_a_workflow_group_folder_calls_the_selected_one(
    cli_case: CliCase,
):
    name = _record(cli_case, "app-abcz", FIRST_ID)
    assert cli_case.run_cli(["select-context", name]).returncode == 0

    result = cli_case.run_cli(["curl", '{"query": "World"}'], cwd=_outside(cli_case))

    assert result.returncode == 1, _said(result)
    assert f"Acting on {name}" in result.stderr, _said(result)
    assert API_DOWN in result.stderr, _said(result)
    assert "No workflow group is selected" not in _said(result)


def test_a_selected_deployment_that_is_gone_is_an_error_that_says_what_to_do(
    cli_case: CliCase,
):
    name = _record(cli_case, "app-abcz", FIRST_ID)
    assert cli_case.run_cli(["select-context", name]).returncode == 0
    shutil.rmtree(_record_dir(cli_case, name))
    outside = _outside(cli_case)

    for command in (["status"], ["stop"], ["test"]):
        result = cli_case.run_cli(command, cwd=outside)
        assert result.returncode == 1, _said(result)
        assert f"`{name}` is no longer recorded" in _said(result)
        assert "canyonos list" in _said(result) and PICK_AGAIN in _said(result)
        assert "Traceback" not in result.stderr, result.stderr
    listed = cli_case.run_cli(["list"])
    assert listed.returncode == 0, _said(listed)
    assert f"`{name}` is no longer" in _said(listed) and PICK_AGAIN in _said(listed)

    cleared = cli_case.run_cli(["select-context", "--clear"])
    assert cleared.returncode == 0, _said(cleared)
    assert not (cli_case.home / ".canyonos" / "context.json").exists()


def test_status_in_a_workflow_folder_acts_on_its_workflow_group_not_the_selected(
    cli_case: CliCase,
):
    first = _record(cli_case, "app-abcz", FIRST_ID)
    second = _record(cli_case, "app-xyza", SECOND_ID)
    assert cli_case.run_cli(["select-context", second]).returncode == 0
    folder = cli_case.cwd / "app-abcz"

    for cwd in (folder, folder / "config"):
        result = cli_case.run_cli(["status", "--json"], cwd=cwd)
        assert result.returncode == 1, _said(result)
        assert json.loads(result.stdout)["workflow_group"] == first, result.stdout
        assert "Acting on" not in result.stderr, _said(result)


def test_stop_in_a_workflow_folder_acts_on_its_workflow_group(cli_case: CliCase):
    """With two workflow groups deployed, `stop` without a name, run from one's workflow
    folder, acts on that one without asking."""
    first = _record(cli_case, "app-abcz", FIRST_ID)
    _record(cli_case, "app-xyza", SECOND_ID)

    result = cli_case.run_cli(
        ["stop", "--json"], env=NO_DOCKER, cwd=cli_case.cwd / "app-abcz", timeout=30
    )

    assert json.loads(result.stdout)["workflow_groups"] == [first], _said(result)


def test_stop_of_a_workflow_group_that_is_not_deployed_fails(cli_case: CliCase):
    name = _record(cli_case, "app-abcz", FIRST_ID, deployed=False)

    result = cli_case.run_cli(["stop", name], env=NO_DOCKER)

    assert result.returncode == 1, _said(result)
    assert f"{name} is not deployed" in _said(result), _said(result)
    assert _record_dir(cli_case, name).is_dir()


def test_stop_in_the_folder_of_a_workflow_group_not_deployed_has_nothing_to_do(
    cli_case: CliCase,
):
    """Run from its workflow folder, `stop` of a workflow group already stopped says so
    and succeeds, and stops no other workflow group."""
    name = _record(cli_case, "app-abcz", FIRST_ID, deployed=False)
    _record(cli_case, "app-xyza", SECOND_ID)

    result = cli_case.run_cli(
        ["stop", "--json"], env=NO_DOCKER, cwd=cli_case.cwd / "app-abcz", timeout=30
    )

    assert result.returncode == 0, _said(result)
    assert json.loads(result.stdout)["workflow_groups"] == [], result.stdout
    assert _record_dir(cli_case, name).is_dir()


def test_clean_in_a_workflow_folder_removes_its_record_and_finishes(
    cli_case: CliCase,
):
    """`clean` with no name, from the workflow folder, runs from the record it then
    removes, and goes on from elsewhere: it finishes, and says so."""
    name = _record(cli_case, "app-abcz", FIRST_ID, deployed=False)

    result = cli_case.run_cli(
        ["clean", "--yes", "--json"], cwd=cli_case.cwd / "app-abcz", timeout=60
    )

    assert result.returncode == 0, _said(result)
    assert json.loads(result.stdout)["workflow_groups"] == [name], result.stdout
    assert not _record_dir(cli_case, name).exists()


def test_stop_in_a_folder_of_two_workflow_groups_refuses_and_stops_neither(
    cli_case: CliCase,
):
    """Run from a folder that holds the workflow folders of two workflow groups, one
    of them deployed, `stop` with no name refuses, as the other commands do, rather
    than stop the deployed one."""
    _record(cli_case, "app-abcz", FIRST_ID)
    _record(cli_case, "app-xyza", SECOND_ID, deployed=False)

    result = cli_case.run_cli(["stop"], env=NO_DOCKER, timeout=30)

    assert result.returncode == 1, _said(result)
    assert "belongs to 2 workflow groups" in _said(result), _said(result)


def test_clean_removes_the_whole_record_of_a_workflow_group(cli_case: CliCase):
    name = _record(cli_case, "app-abcz", FIRST_ID, deployed=False)

    result = cli_case.run_cli(["clean", name, "--yes"], env=NO_DOCKER)

    assert f"Removed {_record_dir(cli_case, name)}" in _said(result), _said(result)
    assert not _record_dir(cli_case, name).exists()
    assert (cli_case.cwd / "app-abcz" / "config").is_dir()
    listed = cli_case.run_cli(["list"])
    assert "No workflow group on this machine" in _said(listed), _said(listed)


def test_dashboard_prints_a_link_that_signs_in_with_the_api_key(cli_case: CliCase):
    env = {**_with_a_running_dashboard(cli_case), "CANYONOS_API_KEY": API_KEY}

    result = cli_case.run_cli(["dashboard"], env=env)

    assert result.returncode == 0, _said(result)
    link = urlsplit(result.stdout.strip())
    assert link.port == DASHBOARD_PORT, result.stdout
    assert link.path == "/login" and not link.query, result.stdout
    assert link.fragment == f"key={quote(API_KEY, safe='')}", result.stdout
    assert API_KEY not in result.stderr, result.stderr


def test_dashboard_signs_in_with_the_key_of_the_workflow_group_it_runs_from(
    cli_case: CliCase,
):
    """Each workflow group's record keeps its own key: the link from one workflow
    group's folder signs in with that one's, never the other's."""
    env = _with_a_running_dashboard(cli_case)
    keys = {"app-abcz": API_KEY, "app-xyza": "e2e other group's key"}
    for (folder, key), deployment_id in zip(keys.items(), (FIRST_ID, SECOND_ID)):
        name = _record(cli_case, folder, deployment_id)
        (_record_dir(cli_case, name) / "api_key").write_text(f"{key}\n")

    for folder, key in keys.items():
        result = cli_case.run_cli(["dashboard"], env=env, cwd=cli_case.cwd / folder)

        assert result.returncode == 0, _said(result)
        link = urlsplit(result.stdout.strip())
        assert link.fragment == f"key={quote(key, safe='')}", result.stdout
        assert "this workflow group's API key" in _said(result), _said(result)


def test_dashboard_without_an_api_key_prints_the_bare_dashboard_url(
    cli_case: CliCase,
):
    result = cli_case.run_cli(["dashboard"], env=_with_a_running_dashboard(cli_case))

    assert result.returncode == 0, _said(result)
    link = urlsplit(result.stdout.strip())
    assert link.port == DASHBOARD_PORT, result.stdout
    assert link.path in ("", "/") and not link.fragment, result.stdout
