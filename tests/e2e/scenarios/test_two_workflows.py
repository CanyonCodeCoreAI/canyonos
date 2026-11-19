# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Two `canyonos new-app` workflows deployed as one workflow group, from a workflow group
folder `canyonos deploy --workflow-group` makes, each answer at their own route,
`canyonos sync` of one leaves the other in the workflow group, and a redeploy of one
reuses the Global Controller and drops the other. Two folders of the same
name are two workflows, each with its own workflow_id, kept across redeploys."""

import pytest
import yaml

from ..conftest import DEPLOY_TIMEOUT
from ..harness import canyonos, cli_value, docker, stop_workflow_group, workflow_name

WORKFLOWS = ("alpha", "beta")
TEST_TIMEOUT = 300


@pytest.fixture
def deployment(recorder, images, tmp_path):
    """The workflow group folder beside two fresh starters, made by the deploy; whatever
    it deploys is stopped afterwards."""
    for name in WORKFLOWS:
        (tmp_path / name).mkdir()
        canyonos(recorder, ["new-app"], cwd=tmp_path / name)
    folder = tmp_path / "deployment"
    yield folder
    stop_workflow_group(recorder, folder)


def _workflow_ids(deployment, folders):
    """The workflow_id the workflow group gave each of `folders`, sorted."""
    workflows = yaml.safe_load((deployment / "workflow_group.yaml").read_text())[
        "workflows"
    ]
    return sorted(
        workflows[workflow_name(folder, deployment)]["workflow_id"]
        for folder in folders
    )


def _answered_routes(recorder, folder):
    """The route paths `canyonos test` got an answer from."""
    call = canyonos(
        recorder, ["test", "--json"], cwd=folder, timeout=TEST_TIMEOUT, check=False
    )
    assert call.code == 0, call.output
    return sorted(r["url"].split("/", 3)[3] for r in call.json()["results"])


def test_two_workflows_share_a_workflow_group_and_sync_one(recorder, deployment):
    canyonos(
        recorder,
        ["deploy", *WORKFLOWS, "--workflow-group", deployment.name],
        cwd=deployment.parent,
        timeout=DEPLOY_TIMEOUT,
    )
    routes = _workflow_ids(deployment, [deployment.parent / name for name in WORKFLOWS])
    assert _answered_routes(recorder, deployment) == routes

    canyonos(recorder, ["sync", "../alpha"], cwd=deployment)

    controller = cli_value(
        recorder,
        deployment,
        "gc_container_name()",
        "from canyonos.deployment import gc_container_name",
    )
    kept = docker(
        recorder,
        [
            "exec",
            controller,
            "test",
            "-f",
            f"/workspace/{workflow_name(deployment.parent / 'beta', deployment)}"
            "/config/workflow_config.yaml",
        ],
        check=False,
    )
    assert kept.code == 0, "syncing alpha removed beta from the workflow group"
    assert _answered_routes(recorder, deployment) == routes

    redeploy = canyonos(
        recorder, ["deploy", "../alpha"], cwd=deployment, timeout=DEPLOY_TIMEOUT
    )
    assert "Global Controller already running" in redeploy.output, redeploy.output
    dropped = docker(
        recorder,
        [
            "exec",
            controller,
            "test",
            "-f",
            f"/workspace/{workflow_name(deployment.parent / 'beta', deployment)}"
            "/config/workflow_config.yaml",
        ],
        check=False,
    )
    assert dropped.code != 0, "redeploying alpha alone kept beta in the workflow group"
    alpha = _workflow_ids(deployment, [deployment.parent / "alpha"])
    assert _answered_routes(recorder, deployment) == alpha


def test_two_folders_of_the_same_name_are_two_workflows(recorder, images, tmp_path):
    folders = [tmp_path / "testing" / "app", tmp_path / "production" / "app"]
    for folder in folders:
        folder.mkdir(parents=True)
        canyonos(recorder, ["new-app"], cwd=folder)
    deployment = tmp_path / "deployment"
    first = None
    try:
        for _ in range(2):
            canyonos(
                recorder,
                [
                    "deploy",
                    "testing/app",
                    "production/app",
                    "--workflow-group",
                    "deployment",
                ],
                cwd=tmp_path,
                timeout=DEPLOY_TIMEOUT,
            )
            routes = _workflow_ids(deployment, folders)
            assert len(set(routes)) == 2, routes
            assert _answered_routes(recorder, deployment) == routes
            # A redeploy keeps each folder's workflow_id.
            first = first or routes
            assert routes == first
    finally:
        stop_workflow_group(recorder, deployment)
