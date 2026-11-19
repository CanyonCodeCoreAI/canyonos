# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""A Docker restart, `canyonos stop --all` and `canyonos serve`. helloworld deploys
from two folders, `kept` and `gone`, one after the other, and each answers and sends
its traces to the dashboard. No container of either workflow group or of the dashboard has
a restart policy but each workflow's machine-metrics collector, which Docker brings
back, so stopping all the others stands in for a Docker restart: `canyonos serve`
then lists both workflows with their traces. With `gone`'s folder deleted, `canyonos
stop --all` removes both workflow groups and stops the dashboard, and `kept`'s next deploy
gets Redis 6379 and endpoint 8080 with no port warning. The cases are steps on one
fleet: once one fails, the rest are skipped."""

import re
import shutil
from dataclasses import dataclass
from pathlib import Path

import pytest

from ..harness import (
    Api,
    api_url,
    canyonos,
    dashboard_containers,
    dashboard_key,
    deployed_endpoint,
    deployed_workflow_id,
    deployment_group,
    docker,
    greets,
    poll,
    workflow_group_containers,
    workflow_dir,
    redis_port,
    stage,
    traces,
)
from ..workflows import load_workflow

pytestmark = pytest.mark.steps

COPIES = ("kept", "gone")
DASHBOARD_GROUP = "canyonos-dashboard"
DEPLOY_TIMEOUT = 1800
TRACE_TIMEOUT = 60


@dataclass
class Fleet:
    """Each copy's folder, the folder above both, and each copy's Docker group and
    dashboard id once it is deployed."""

    dirs: dict[str, Path]
    parent: Path
    groups: dict[str, str]
    ids: dict[str, str]


@pytest.fixture(scope="module")
def fleet(request, recorder, images, tmp_path_factory) -> Fleet:
    """helloworld staged under `kept/` and `gone/`, after `canyonos serve`, as for the
    `deployed` fixture: the dashboard API reads the hash of the session's API key
    only when it starts, and a deploy leaves a running dashboard as it is. Every workflow group on the
    machine is stopped afterwards and the dashboard removed, whether the steps passed
    or not."""
    parent = tmp_path_factory.mktemp("restart")
    # Finalizers run last-added first, so this runs after `stop --all`.
    request.addfinalizer(
        lambda: docker(
            recorder,
            ["compose", "-p", DASHBOARD_GROUP, "down", "--remove-orphans"],
            check=False,
        )
    )
    request.addfinalizer(
        lambda: canyonos(recorder, ["stop", "--all"], cwd=parent, check=False)
    )
    canyonos(recorder, ["serve"], cwd=parent, timeout=600)
    dirs = {}
    for copy in COPIES:
        (parent / copy).mkdir()
        dirs[copy] = stage(recorder, load_workflow("helloworld"), parent / copy, {})
    return Fleet(dirs=dirs, parent=parent, groups={}, ids={})


def _deploy(recorder, directory: Path):
    return canyonos(
        recorder,
        ["deploy", str(workflow_dir(directory))],
        cwd=directory,
        timeout=DEPLOY_TIMEOUT,
    )


def test_two_workflow_groups_deploy_one_after_the_other_and_answer(recorder, fleet):
    for copy in COPIES:
        _deploy(recorder, fleet.dirs[copy])
        fleet.groups[copy] = deployment_group(recorder, fleet.dirs[copy])
        greets(recorder, fleet.dirs[copy], copy)
    api = Api(recorder, api_url(recorder), dashboard_key(recorder))
    for copy in COPIES:
        workflow_id = deployed_workflow_id(api, fleet.dirs[copy])
        fleet.ids[copy] = workflow_id
        poll(
            lambda: traces(api, workflow_id),
            timeout=TRACE_TIMEOUT,
            interval=2,
            what=f"{copy}'s traces on the dashboard",
        )


def test_after_docker_stops_everything_serve_lists_both_with_their_history(
    recorder, fleet
):
    containers = [
        *(
            name
            for group in fleet.groups.values()
            for name in workflow_group_containers(recorder, group)
        ),
        *dashboard_containers(recorder),
    ]
    inspected = docker(
        recorder,
        ["inspect", "-f", "{{.Name}} {{.HostConfig.RestartPolicy.Name}}", *containers],
    ).output
    policies = dict(line.lstrip("/").split(" ") for line in inspected.splitlines())
    collectors = {f"{group}-metrics-localhost" for group in fleet.groups.values()}
    restarted = {name: policy for name, policy in policies.items() if policy != "no"}
    assert restarted == dict.fromkeys(collectors, "unless-stopped"), policies
    docker(recorder, ["stop", *(name for name in containers if name not in collectors)])

    canyonos(recorder, ["serve"], cwd=fleet.dirs["kept"])

    api = Api(recorder, api_url(recorder), dashboard_key(recorder))
    listed = {workflow["id"] for workflow in api.get("/workflows").json()}
    assert set(fleet.ids.values()) <= listed, listed
    for copy in COPIES:
        assert traces(api, fleet.ids[copy]), f"{copy}'s traces are gone"


def test_stop_all_tears_down_a_workflow_group_whose_folder_is_gone(recorder, fleet):
    shutil.rmtree(fleet.dirs["gone"])

    canyonos(recorder, ["stop", "--all"], cwd=fleet.parent)

    for group in fleet.groups.values():
        left = workflow_group_containers(recorder, group, every=True)
        assert not left, left
    assert not dashboard_containers(recorder), dashboard_containers(recorder)


def test_the_next_deploy_gets_the_default_ports(recorder, fleet):
    kept = fleet.dirs["kept"]

    call = _deploy(recorder, kept)

    taken = re.findall(r"[^.]*is taken[^.]*", " ".join(call.output.split()))
    assert not taken, taken
    assert redis_port(recorder, kept) == 6379
    assert deployed_endpoint(recorder, kept).url == "http://127.0.0.1:8080"
