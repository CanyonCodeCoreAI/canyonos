# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""`canyonos stop` and `canyonos clean` pick the workflow groups deployed on this machine
from any folder, by name or ID as Docker picks containers, or in a menu. Two copies
of helloworld deploy from folders both named `helloworld`, so only their IDs tell
them apart. Without a terminal, a stop that would have to ask names both and stops
neither, and the shared folder name is refused as ambiguous. In a terminal, `clean`
lists both and cleans only the one ticked with space and confirmed with enter.
`canyonos list` shows both running; once one is selected, `status` and `test`
outside every folder act on it, while a folder's own workflow group still wins, and a
selected workflow group that is gone makes `stop` fail rather than stop the other.
`canyonos dashboard` prints a link whose fragment carries the API key that signs
the dashboard in. Once
the other's Global Controller is gone, a stop with one workflow left acts without
asking, reports it already gone and removes the Redis and replicas it left. Naming
a workflow group that is no longer deployed fails, and `clean` in its folder still finds
it by ID. The cases are steps on one fleet: once one fails, the rest are skipped."""

import json
import re
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest

from ..harness import (
    bearer,
    api_url,
    canyonos,
    canyonos_in_terminal,
    cli_value,
    dashboard_containers,
    docker,
    http,
    poll,
    workflow_group_containers,
    workflow_dir,
    stage,
)
from ..workflows import load_workflow

pytestmark = pytest.mark.steps

COPIES = ("first", "second")
DASHBOARD_CONTAINERS = 3
DEPLOY_TIMEOUT = 1800
DOWN = "\x1b[B"
GC_ROLE_LABEL = "canyonos.role=global-controller"
PROJECT_LABEL = "com.docker.compose.project"
SECOND_API_PORT = 8082
SECOND_REDIS_PORT = 6380
SKILL = Path(".claude/skills/converting-to-canyonos/SKILL.md")
CONTEXT = Path.home() / ".canyonos" / "context.json"


@dataclass
class Fleet:
    """Each copy's workflow group folder, workflow group name (`helloworld-<id[:8]>`) and
    deployment_id, and an empty folder to run commands from outside every workflow."""

    dirs: dict[str, Path]
    names: dict[str, str]
    ids: dict[str, str]
    outside: Path


def _pin_ports(directory: Path) -> None:
    """Give the copy fixed ports, so the two deploys can't race for the same ones.
    helloworld's workflow_group.yaml sets neither, so both blocks are added."""
    path = directory / "workflow_group.yaml"
    text = path.read_text()
    assert not re.search(r"^(endpoint|redis):", text, flags=re.M), text
    path.write_text(
        text.rstrip("\n")
        + f"\n\nendpoint:\n  api_port: {SECOND_API_PORT}\n"
        + f"\nredis:\n  port: {SECOND_REDIS_PORT}\n"
    )


def _running_workflow_groups(recorder) -> set[str]:
    """The names of the workflow groups whose Global Controller runs."""
    listing = docker(
        recorder,
        [
            "ps",
            "--filter",
            f"label={GC_ROLE_LABEL}",
            "--format",
            f'{{{{.Label "{PROJECT_LABEL}"}}}}',
        ],
    ).output
    return {group.removeprefix("canyonos-") for group in listing.split()}


def _all_replicas_up(recorder, directory: Path) -> bool:
    """Whether `status --json` in `directory` shows every agent running all its
    replicas; fails at once when the deploy has stopped."""
    report = canyonos(recorder, ["status", "--json"], cwd=directory, check=False).json()
    assert report["running"], f"the deploy stopped: {report}"
    agents = report["agents"] or []
    return bool(agents) and all(
        1 <= agent["running_replicas"] == agent["desired_replicas"] for agent in agents
    )


def _records() -> list[str]:
    """The workflow groups with a deploy record, in the order the CLI lists them."""
    deployments = Path.home() / ".canyonos" / "deployments"
    return sorted(path.parent.name for path in deployments.glob("*/state.json"))


def _images(recorder, name: str) -> list[str]:
    listing = docker(
        recorder,
        [
            "images",
            "--filter",
            f"reference=canyonos-{name}-*",
            "--format",
            "{{.Repository}}",
        ],
    ).output
    return listing.split()


def _tear_down(recorder, fleet_dirs: dict[str, Path], parent: Path) -> None:
    """Stop every workflow, then clean each copy's folder, whether the steps passed."""
    stopped = canyonos(
        recorder, ["stop", "--all"], cwd=parent, timeout=600, check=False
    )
    for directory in fleet_dirs.values():
        canyonos(recorder, ["clean"], cwd=directory, timeout=600, check=False)
    assert stopped.code == 0, stopped.output[-3000:]


@pytest.fixture(scope="module")
def fleet(request, recorder, images, tmp_path_factory) -> Fleet:
    """Both copies staged under different parents, the second on fixed ports, then
    deployed at the same time: the first with `--json`, which reports it up with its
    endpoint, and the second in a terminal with `--yes --detach`, so it returns
    without the resource picker and is up once `status --json` says so."""
    parent = tmp_path_factory.mktemp("stop-and-clean")
    dirs: dict[str, Path] = {}
    request.addfinalizer(lambda: _tear_down(recorder, dirs, parent))
    for copy in COPIES:
        (parent / copy).mkdir()
        dirs[copy] = stage(recorder, load_workflow("helloworld"), parent / copy, {})
    _pin_ports(dirs["second"])
    with ThreadPoolExecutor(max_workers=1) as pool:
        first = pool.submit(
            canyonos,
            recorder,
            ["deploy", str(workflow_dir(dirs["first"])), "--json"],
            cwd=dirs["first"],
            timeout=DEPLOY_TIMEOUT,
        )
        detached = canyonos_in_terminal(
            recorder,
            ["deploy", str(workflow_dir(dirs["second"])), "--yes", "--detach"],
            cwd=dirs["second"],
            answers=[],
        )
        assert "Deploy started." in detached.output, detached.output
        poll(
            lambda: _all_replicas_up(recorder, dirs["second"]),
            timeout=DEPLOY_TIMEOUT,
            what="the detached deploy's replicas in status --json",
        )
        deployed = first.result().json()
        assert deployed["ok"] and deployed["status"]["running"], deployed
        assert deployed["status"]["endpoint"]["routes"][0]["url"], deployed
    identity = {
        copy: cli_value(
            recorder,
            dirs[copy],
            "[deployment_name(), read_config(deployment_config_path())['workflow_group_id']]",
            "from canyonos.deployment import deployment_name; "
            "from canyonos.constants import deployment_config_path, read_config",
        )
        for copy in COPIES
    }
    outside = parent / "outside"
    outside.mkdir()
    return Fleet(
        dirs=dirs,
        names={copy: name for copy, (name, _) in identity.items()},
        ids={
            copy: workflow_group_id for copy, (_, workflow_group_id) in identity.items()
        },
        outside=outside,
    )


def test_both_deploy_from_folders_of_the_same_name(recorder, fleet):
    assert {path.name for path in fleet.dirs.values()} == {"helloworld"}
    assert fleet.names["first"] != fleet.names["second"], fleet.names
    assert set(fleet.names.values()) <= _running_workflow_groups(recorder)
    assert set(fleet.names.values()) <= set(_records())


def test_without_a_terminal_stop_names_both_and_stops_neither(recorder, fleet):
    call = canyonos(recorder, ["stop"], cwd=fleet.outside, check=False)

    assert call.code == 1, call.output
    for copy in COPIES:
        assert fleet.ids[copy] in call.output, call.output
        assert str(fleet.dirs[copy]) in call.output, call.output
    assert "canyonos stop <name or ID>" in call.output, call.output
    assert set(fleet.names.values()) <= _running_workflow_groups(recorder)


def test_the_shared_folder_name_is_refused_as_ambiguous(recorder, fleet):
    call = canyonos(recorder, ["stop", "helloworld"], cwd=fleet.outside, check=False)

    assert call.code == 1, call.output
    assert "matches 2 workflow groups" in call.output, call.output
    for copy in COPIES:
        assert fleet.ids[copy] in call.output, call.output
    assert set(fleet.names.values()) <= _running_workflow_groups(recorder)


def _tested_ports(recorder, cwd: Path) -> set[int]:
    """The endpoint ports `canyonos test` in `cwd` got its answers from."""
    call = canyonos(recorder, ["test", "Ada", "--json"], cwd=cwd, timeout=300)
    return {urlsplit(result["url"]).port for result in call.json()["results"]}


def test_the_selected_deployment_is_the_one_commands_act_on_outside_its_folder(
    recorder, fleet
):
    second = fleet.names["second"]
    try:
        listed = canyonos(recorder, ["list"], cwd=fleet.outside)
        canyonos(
            recorder, ["select-context", fleet.ids["second"][:12]], cwd=fleet.outside
        )
        selected = canyonos(recorder, ["list"], cwd=fleet.outside)
        status = canyonos(recorder, ["status", "--json"], cwd=fleet.outside)

        for copy in COPIES:
            line = next(
                line for line in listed.stdout.splitlines() if fleet.names[copy] in line
            )
            assert fleet.ids[copy] in line, listed.output
            assert "running" in line and "not running" not in line, listed.output
        assert "(selected)" not in listed.output, listed.output
        marked = [line for line in selected.stdout.splitlines() if "(selected)" in line]
        assert len(marked) == 1 and second in marked[0], selected.output
        assert f"Acting on {second}" in status.output, status.output
        endpoint = json.loads(status.stdout)["endpoint"]
        assert endpoint["api_port"] == SECOND_API_PORT, status.stdout
        assert _tested_ports(recorder, fleet.outside) == {SECOND_API_PORT}
        assert SECOND_API_PORT not in _tested_ports(recorder, fleet.dirs["first"])
    finally:
        canyonos(recorder, ["select-context", "--clear"], cwd=fleet.outside)


def test_dashboard_without_a_terminal_prints_a_link_that_signs_in_with_the_key(
    recorder, fleet
):
    call = canyonos(recorder, ["dashboard"], cwd=fleet.outside)

    link = urlsplit(call.stdout.strip())
    assert link.path == "/login" and not link.query, call.stdout
    assert parse_qs(link.fragment) == {"key": [recorder.api_key]}, call.stdout
    checked = http(
        recorder,
        "GET",
        f"{api_url(recorder)}/v1/auth/check",
        headers=bearer(recorder.api_key),
    )
    assert checked.json() == {"ok": True}, checked.output


def test_clean_in_a_terminal_cleans_only_the_ticked_workflow_group(recorder, fleet):
    second, first = fleet.names["second"], fleet.names["first"]
    skill = fleet.dirs["second"] / SKILL
    skill.parent.mkdir(parents=True)
    skill.write_text("skill")
    assert _images(recorder, second), f"{second} has no agent images"
    keys = DOWN * _records().index(second) + " " + "\r"

    call = canyonos_in_terminal(
        recorder,
        ["clean"],
        cwd=fleet.outside,
        answers=[("Select the workflow groups to clean", keys)],
    )

    for copy in COPIES:
        assert fleet.names[copy] in call.output, call.output
    assert f"{second} torn down" in call.output, call.output
    assert not workflow_group_containers(recorder, f"canyonos-{second}", every=True)
    assert not _images(recorder, second)
    assert not (fleet.dirs["second"] / ".claude").exists()
    assert second not in _records()
    assert first in _running_workflow_groups(recorder)
    assert _images(recorder, first)
    assert len(dashboard_containers(recorder)) == DASHBOARD_CONTAINERS


def test_stop_refuses_a_selected_deployment_that_is_gone_and_leaves_the_other(
    recorder, fleet
):
    second, first = fleet.names["second"], fleet.names["first"]
    CONTEXT.write_text(json.dumps({"deployment": second}))
    try:
        call = canyonos(recorder, ["stop"], cwd=fleet.outside, check=False)
    finally:
        CONTEXT.unlink()

    assert call.code == 1, call.output
    assert f"`{second}` is no longer deployed" in call.output, call.output
    assert "canyonos list" in call.output, call.output
    assert "Traceback" not in call.output, call.output
    assert first in _running_workflow_groups(recorder)


def test_with_one_workflow_group_left_stop_refuses_it_once_its_controller_is_down(
    recorder, fleet
):
    first = fleet.names["first"]
    others = _running_workflow_groups(recorder) - {first}
    assert not others, f"other workflow groups run on this machine: {others}"
    docker(recorder, ["rm", "-f", f"canyonos-{first}-global-controller"])

    call = canyonos(recorder, ["stop"], cwd=fleet.outside, check=False)

    assert call.code == 1, call.output
    assert f"Run `canyonos stop {first}` to force it." in call.output, call.output
    assert "stop --all" not in call.output, call.output
    assert workflow_group_containers(recorder, f"canyonos-{first}", every=True)
    assert first in _records()


def test_naming_a_workflow_group_whose_controller_is_down_forces_its_stop(
    recorder, fleet
):
    first = fleet.names["first"]

    call = canyonos(recorder, ["stop", first, "--json"], cwd=fleet.outside)

    expected = {"ok": True, "code": None, "errors": [], "workflow_groups": [first]}
    assert call.json() == expected, call.output
    assert not workflow_group_containers(recorder, f"canyonos-{first}", every=True)
    assert first not in _records()
    assert not dashboard_containers(recorder)
    assert len(dashboard_containers(recorder, every=True)) == DASHBOARD_CONTAINERS


def test_a_workflow_group_no_longer_deployed_is_found_only_in_its_folder(
    recorder, fleet
):
    first_id = fleet.ids["first"][:12]

    missing = canyonos(recorder, ["stop", first_id], cwd=fleet.outside, check=False)
    canyonos(recorder, ["clean", first_id], cwd=fleet.dirs["first"])

    assert missing.code == 1, missing.output
    assert f"No workflow group is named `{first_id}`" in missing.output, missing.output
    assert not _images(recorder, fleet.names["first"])
