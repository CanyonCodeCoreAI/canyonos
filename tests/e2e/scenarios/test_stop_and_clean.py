# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""`canyonos stop` and `canyonos clean` pick the projects deployed on this machine
from any folder, by name or ID as Docker picks containers, or in a menu. Two copies
of helloworld deploy from folders both named `helloworld`, so only their IDs tell
them apart. Without a terminal, a stop that would have to ask names both and stops
neither, and the shared folder name is refused as ambiguous. In a terminal, `clean`
lists both and cleans only the one ticked with space and confirmed with enter. Once
the other's Global Controller is gone, a stop with one project left acts without
asking, reports it already gone and removes the Redis and replicas it left. Naming
a project that is no longer deployed fails, and `clean` in its folder still finds
it by ID. The cases are steps on one fleet: once one fails, the rest are skipped."""

import re
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

import pytest

from ..harness import (
    canyonos,
    canyonos_in_terminal,
    cli_value,
    dashboard_containers,
    docker,
    project_containers,
    project_root,
    stage,
)
from ..projects import load_project

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


@dataclass
class Fleet:
    """Each copy's folder, project name (`helloworld-<id[:8]>`) and project_id, and an
    empty folder to run commands from outside every project."""

    dirs: dict[str, Path]
    names: dict[str, str]
    ids: dict[str, str]
    outside: Path


def _pin_ports(directory: Path) -> None:
    """Give the copy fixed ports, so the two deploys can't race for the same ones."""
    path = project_root(directory) / "config" / "global_controller.yaml"
    text = re.sub(
        r"^endpoint:$",
        f"endpoint:\n  api_port: {SECOND_API_PORT}",
        path.read_text(),
        flags=re.M,
    )
    path.write_text(
        re.sub(r"^redis:$", f"redis:\n  port: {SECOND_REDIS_PORT}", text, flags=re.M)
    )


def _running_projects(recorder) -> set[str]:
    """The names of the projects whose Global Controller runs."""
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


def _records() -> list[str]:
    """The projects with a deploy record, in the order the CLI lists them."""
    projects = Path.home() / ".canyonos" / "projects"
    return sorted(path.parent.name for path in projects.glob("*/state.json"))


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
    """Stop every project, then clean each copy's folder, whether the steps passed."""
    stopped = canyonos(
        recorder, ["stop", "--all"], cwd=parent, timeout=600, check=False
    )
    for directory in fleet_dirs.values():
        canyonos(recorder, ["clean"], cwd=directory, timeout=600, check=False)
    assert stopped.code == 0, stopped.output[-3000:]


@pytest.fixture(scope="module")
def fleet(request, recorder, images, tmp_path_factory) -> Fleet:
    """Both copies staged under different parents, the second on fixed ports, then
    deployed at the same time."""
    parent = tmp_path_factory.mktemp("stop-and-clean")
    dirs: dict[str, Path] = {}
    request.addfinalizer(lambda: _tear_down(recorder, dirs, parent))
    for copy in COPIES:
        (parent / copy).mkdir()
        dirs[copy] = stage(recorder, load_project("helloworld"), parent / copy, {})
    _pin_ports(dirs["second"])
    with ThreadPoolExecutor(max_workers=len(COPIES)) as pool:
        deploys = [
            pool.submit(
                canyonos, recorder, ["deploy"], cwd=dirs[copy], timeout=DEPLOY_TIMEOUT
            )
            for copy in COPIES
        ]
        for deploy in deploys:
            deploy.result()
    identity = {
        copy: cli_value(
            recorder,
            dirs[copy],
            "[project_name(), read_config(default_config_path())['project_id']]",
            "from canyonos.project import project_name; "
            "from canyonos.constants import default_config_path, read_config",
        )
        for copy in COPIES
    }
    outside = parent / "outside"
    outside.mkdir()
    return Fleet(
        dirs=dirs,
        names={copy: name for copy, (name, _) in identity.items()},
        ids={copy: project_id for copy, (_, project_id) in identity.items()},
        outside=outside,
    )


def test_both_deploy_from_folders_of_the_same_name(recorder, fleet):
    assert {path.name for path in fleet.dirs.values()} == {"helloworld"}
    assert fleet.names["first"] != fleet.names["second"], fleet.names
    assert set(fleet.names.values()) <= _running_projects(recorder)
    assert set(fleet.names.values()) <= set(_records())


def test_without_a_terminal_stop_names_both_and_stops_neither(recorder, fleet):
    call = canyonos(recorder, ["stop"], cwd=fleet.outside, check=False)

    assert call.code == 1, call.output
    for copy in COPIES:
        assert fleet.ids[copy] in call.output, call.output
        assert str(fleet.dirs[copy]) in call.output, call.output
    assert "canyonos stop <name or ID>" in call.output, call.output
    assert set(fleet.names.values()) <= _running_projects(recorder)


def test_the_shared_folder_name_is_refused_as_ambiguous(recorder, fleet):
    call = canyonos(recorder, ["stop", "helloworld"], cwd=fleet.outside, check=False)

    assert call.code == 1, call.output
    assert "matches 2 projects" in call.output, call.output
    for copy in COPIES:
        assert fleet.ids[copy] in call.output, call.output
    assert set(fleet.names.values()) <= _running_projects(recorder)


def test_clean_in_a_terminal_cleans_only_the_ticked_project(recorder, fleet):
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
        answers=[("Select the projects to clean", keys)],
    )

    for copy in COPIES:
        assert fleet.names[copy] in call.output, call.output
    assert f"{second} torn down" in call.output, call.output
    assert not project_containers(recorder, f"canyonos-{second}", every=True)
    assert not _images(recorder, second)
    assert not (fleet.dirs["second"] / ".claude").exists()
    assert second not in _records()
    assert first in _running_projects(recorder)
    assert _images(recorder, first)
    assert len(dashboard_containers(recorder)) == DASHBOARD_CONTAINERS


def test_with_one_project_left_stop_refuses_it_once_its_controller_is_down(
    recorder, fleet
):
    first = fleet.names["first"]
    others = _running_projects(recorder) - {first}
    assert not others, f"other projects run on this machine: {others}"
    docker(recorder, ["rm", "-f", f"canyonos-{first}-global-controller"])

    call = canyonos(recorder, ["stop"], cwd=fleet.outside, check=False)

    assert call.code == 1, call.output
    assert f"Run `canyonos stop {first}` to force it." in call.output, call.output
    assert "stop --all" not in call.output, call.output
    assert project_containers(recorder, f"canyonos-{first}", every=True)
    assert first in _records()


def test_naming_a_project_whose_controller_is_down_forces_its_stop(recorder, fleet):
    first = fleet.names["first"]

    call = canyonos(recorder, ["stop", first], cwd=fleet.outside)

    assert f"{first} torn down" in call.output, call.output
    assert not project_containers(recorder, f"canyonos-{first}", every=True)
    assert first not in _records()
    assert not dashboard_containers(recorder)
    assert len(dashboard_containers(recorder, every=True)) == DASHBOARD_CONTAINERS


def test_a_project_no_longer_deployed_is_found_only_in_its_folder(recorder, fleet):
    first_id = fleet.ids["first"][:12]

    missing = canyonos(recorder, ["stop", first_id], cwd=fleet.outside, check=False)
    canyonos(recorder, ["clean", first_id], cwd=fleet.dirs["first"])

    assert missing.code == 1, missing.output
    assert f"No project is named `{first_id}`" in missing.output, missing.output
    assert not _images(recorder, fleet.names["first"])
