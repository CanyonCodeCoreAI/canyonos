# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Two `canyonos new-app` workflows deployed as one workflow group from the folder
that holds them, each answer at their own route, `canyonos sync` of one leaves the
other in the workflow group, and a redeploy of the workflow group with one of them, by
`--workflow-group`, reuses the Global Controller and drops the other. Each workflow's
`config/` is copied into the workflow group's record on its first deploy, so that
redeploy works with the kept workflow's own `config/` deleted from its folder, and it
removes the copy of the workflow it drops. Two folders of the same name are two
workflows, each with its own workflow_id, kept across redeploys, and a redeploy of the
same folders from another folder finds the same workflow group by their paths."""

import shutil

import pytest

from ..conftest import DEPLOY_TIMEOUT
from ..harness import (
    canyonos,
    cli_value,
    docker,
    group_settings,
    record,
    stop_workflow_group,
    workflow_config_dir,
    workflow_name,
)

WORKFLOWS = ("alpha", "beta")
TEST_TIMEOUT = 300


@pytest.fixture
def deployment(recorder, images, tmp_path):
    """The folder that holds two fresh starters, which the workflow group is deployed
    from; whatever it deploys is stopped afterwards."""
    for name in WORKFLOWS:
        (tmp_path / name).mkdir()
        canyonos(recorder, ["new-app"], cwd=tmp_path / name)
    yield tmp_path
    stop_workflow_group(recorder, tmp_path)


def _workflow_ids(folders):
    """The workflow_id the workflow group gave each of `folders`, sorted."""
    workflows = group_settings(folders[0])["workflows"]
    return sorted(workflows[workflow_name(folder)]["workflow_id"] for folder in folders)


def _answered_routes(recorder, folder):
    """The route paths `canyonos test` got an answer from."""
    call = canyonos(
        recorder, ["test", "--json"], cwd=folder, timeout=TEST_TIMEOUT, check=False
    )
    assert call.code == 0, call.output
    return sorted(r["url"].split("/", 3)[3] for r in call.json()["results"])


def _holds(recorder, controller, workflow):
    """Whether the Global Controller `controller` holds the workflow `workflow`."""
    held = docker(
        recorder,
        [
            "exec",
            controller,
            "test",
            "-f",
            f"/workspace/{workflow}/config/workflow_config.yaml",
        ],
        check=False,
    )
    return held.code == 0


def test_two_workflows_share_a_workflow_group_and_sync_one(recorder, deployment):
    canyonos(recorder, ["deploy", *WORKFLOWS], cwd=deployment, timeout=DEPLOY_TIMEOUT)
    group = record(deployment)
    assert not (deployment / "workflow_group.yaml").exists()
    alpha_config, beta_config = (
        workflow_config_dir(deployment / name) for name in WORKFLOWS
    )
    for kept in (alpha_config, beta_config):
        assert (kept / "workflow_config.yaml").is_file(), kept
    routes = _workflow_ids([deployment / name for name in WORKFLOWS])
    assert _answered_routes(recorder, deployment) == routes

    canyonos(recorder, ["sync", "../alpha"], cwd=deployment / "beta")

    controller = cli_value(
        recorder,
        deployment,
        "gc_container_name()",
        "from canyonos.deployment import gc_container_name",
    )
    beta = workflow_name(deployment / "beta")
    assert _holds(recorder, controller, beta), "syncing alpha removed beta"
    assert _answered_routes(recorder, deployment) == routes

    refused = canyonos(
        recorder,
        ["deploy", "--workflow-group", group.name, "alpha"],
        cwd=deployment,
        check=False,
    )
    assert refused.code != 0 and "Add --yes" in refused.output, refused.output
    assert _holds(recorder, controller, beta), "a refused redeploy dropped beta"

    # The record's copy is what the redeploy uploads, so the folder's can go.
    shutil.rmtree(deployment / "alpha" / "config")
    redeploy = canyonos(
        recorder,
        ["deploy", "--workflow-group", group.name, "alpha", "--yes"],
        cwd=deployment,
        timeout=DEPLOY_TIMEOUT,
    )
    assert "Global Controller already running" in redeploy.output, redeploy.output
    assert record(deployment) == group
    assert not _holds(recorder, controller, beta), "redeploying alpha kept beta"
    assert (alpha_config / "workflow_config.yaml").is_file(), alpha_config
    assert not beta_config.parent.exists(), "redeploying alpha kept beta's config"
    alpha = _workflow_ids([deployment / "alpha"])
    assert _answered_routes(recorder, deployment) == alpha


def test_two_folders_of_the_same_name_are_two_workflows(recorder, images, tmp_path):
    folders = [tmp_path / "testing" / "app", tmp_path / "production" / "app"]
    for folder in folders:
        folder.mkdir(parents=True)
        canyonos(recorder, ["new-app"], cwd=folder)
    # The second deploy runs from another folder, with the same folders.
    deploys = [
        (tmp_path, ["testing/app", "production/app"]),
        (tmp_path / "testing", ["app", "../production/app"]),
    ]
    first = group = None
    try:
        for cwd, paths in deploys:
            canyonos(recorder, ["deploy", *paths], cwd=cwd, timeout=DEPLOY_TIMEOUT)
            group = group or record(tmp_path)
            assert record(tmp_path) == group
            routes = _workflow_ids(folders)
            assert len(set(routes)) == 2, routes
            assert _answered_routes(recorder, tmp_path) == routes
            # A redeploy keeps each folder's workflow_id.
            first = first or routes
            assert routes == first
    finally:
        stop_workflow_group(recorder, tmp_path)
