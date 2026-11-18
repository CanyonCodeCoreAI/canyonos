# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""`canyonos list`, `canyonos select-context` and the commands that act on the selected
deployment, through the installed command, each case in its own HOME. The deployments
are records `canyonos deploy` would write, whose Global Controller port answers
nothing, so no Docker is needed and none is running. `canyonos dashboard` finds the
dashboard through a stand-in `docker` that reports its web container's port, and
prints the link it would open."""

from __future__ import annotations

import json
import os
import socket
import subprocess
from pathlib import Path
from urllib.parse import quote, urlsplit

from .harness import CliCase

FIRST_ID = "8a3f6c1e-2b4d-4e5f-9a7b-1c2d3e4f5a6b"
SECOND_ID = "0f9e8d7c-6b5a-4c3d-8e2f-1a0b9c8d7e6f"
PICK_AGAIN = "`canyonos select-context <deployment>`"
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


def _record(
    case: CliCase, folder: str, deployment_id: str, auth_disabled: bool = False
) -> str:
    """Write the deployment folder `folder` and the record a deploy from it leaves,
    and return the deployment's name."""
    directory = case.cwd / folder
    directory.mkdir()
    (directory / "deployment.yaml").write_text(f"deployment_id: {deployment_id}\n")
    name = f"{folder}-{deployment_id[:8]}"
    records = case.home / ".canyonos" / "deployments" / name
    records.mkdir(parents=True)
    (records / "state.json").write_text(
        json.dumps(
            {
                "container_id": f"{folder}-controller",
                "port": _closed_port(),
                "deployment_id": deployment_id,
                "project_dir": str(directory),
                "auth_disabled": auth_disabled,
            }
        )
    )
    return name


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
    assert "No deployment on this machine" in _said(result)
    assert "canyonos deploy" in _said(result)


def test_list_shows_each_deployment_and_marks_one_deployed_without_an_api_key(
    cli_case: CliCase,
):
    first = _record(cli_case, "app-abcz", FIRST_ID)
    second = _record(cli_case, "app-xyza", SECOND_ID, auth_disabled=True)

    result = cli_case.run_cli(["list"])

    assert result.returncode == 0, _said(result)
    lines = {line.split()[1]: line for line in result.stdout.splitlines()}
    assert set(lines) == {first, second}, result.stdout
    assert FIRST_ID in lines[first] and SECOND_ID in lines[second], result.stdout
    assert "not running" in lines[first], result.stdout
    assert "(unauthenticated)" in lines[second], result.stdout
    assert "(unauthenticated)" not in lines[first], result.stdout
    assert "(selected)" not in result.stdout, result.stdout


def test_select_context_takes_the_forms_stop_takes_and_list_marks_it(
    cli_case: CliCase,
):
    first = _record(cli_case, "app-abcz", FIRST_ID)
    second = _record(cli_case, "app-xyza", SECOND_ID)

    for ref, picked in ((FIRST_ID[:6], first), ("app-xyza", second), (first, first)):
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
    assert "No deployment is named `nope`" in _said(missing)
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

    assert result.returncode == 3, _said(result)
    assert f"Acting on {name}" in result.stderr, _said(result)
    assert "No deploy is currently running" in result.stderr, _said(result)


def test_curl_outside_a_deployment_folder_calls_the_selected_one(cli_case: CliCase):
    name = _record(cli_case, "app-abcz", FIRST_ID)
    assert cli_case.run_cli(["select-context", name]).returncode == 0

    result = cli_case.run_cli(["curl", '{"query": "World"}'], cwd=_outside(cli_case))

    assert result.returncode == 1, _said(result)
    assert f"Acting on {name}" in result.stderr, _said(result)
    assert "No deploy is running" in result.stderr, _said(result)
    assert "No deployment is selected" not in _said(result)


def test_a_selected_deployment_that_is_gone_is_an_error_that_says_what_to_do(
    cli_case: CliCase,
):
    name = _record(cli_case, "app-abcz", FIRST_ID)
    assert cli_case.run_cli(["select-context", name]).returncode == 0
    (cli_case.home / ".canyonos" / "deployments" / name / "state.json").unlink()
    outside = _outside(cli_case)

    for command in (["status"], ["stop"], ["test"]):
        result = cli_case.run_cli(command, cwd=outside)
        assert result.returncode == 1, _said(result)
        assert f"`{name}` is no longer deployed" in _said(result)
        assert "canyonos list" in _said(result) and PICK_AGAIN in _said(result)
        assert "Traceback" not in result.stderr, result.stderr
    listed = cli_case.run_cli(["list"])
    assert listed.returncode == 0, _said(listed)
    assert f"`{name}` is no longer deployed" in _said(listed)

    cleared = cli_case.run_cli(["select-context", "--clear"])
    assert cleared.returncode == 0, _said(cleared)
    assert not (cli_case.home / ".canyonos" / "context.json").exists()


def test_dashboard_prints_a_link_that_signs_in_with_the_api_key(cli_case: CliCase):
    env = {**_with_a_running_dashboard(cli_case), "CANYONOS_API_KEY": API_KEY}

    result = cli_case.run_cli(["dashboard"], env=env)

    assert result.returncode == 0, _said(result)
    link = urlsplit(result.stdout.strip())
    assert link.port == DASHBOARD_PORT, result.stdout
    assert link.path == "/login" and not link.query, result.stdout
    assert link.fragment == f"key={quote(API_KEY, safe='')}", result.stdout
    assert API_KEY not in result.stderr, result.stderr


def test_dashboard_without_an_api_key_prints_the_bare_dashboard_url(
    cli_case: CliCase,
):
    result = cli_case.run_cli(["dashboard"], env=_with_a_running_dashboard(cli_case))

    assert result.returncode == 0, _said(result)
    link = urlsplit(result.stdout.strip())
    assert link.port == DASHBOARD_PORT, result.stdout
    assert link.path in ("", "/") and not link.fragment, result.stdout
