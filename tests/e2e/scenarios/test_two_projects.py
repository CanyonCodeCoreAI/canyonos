# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Two `canyonos new-app` projects deployed as one deployment, from a deployment
folder `canyonos deploy --folder` makes, each answer at their own route,
`canyonos sync` of one leaves the other in the deployment, and a redeploy of one
reuses the Global Controller and drops the other."""

import pytest

from ..conftest import DEPLOY_TIMEOUT
from ..harness import canyonos, cli_value, docker, stop_project

PROJECTS = ("alpha", "beta")
TEST_TIMEOUT = 300


@pytest.fixture
def deployment(recorder, images, tmp_path):
    """The deployment folder beside two fresh starters, made by the deploy; whatever
    it deploys is stopped afterwards."""
    for name in PROJECTS:
        (tmp_path / name).mkdir()
        canyonos(recorder, ["new-app"], cwd=tmp_path / name)
    folder = tmp_path / "deployment"
    yield folder
    stop_project(recorder, folder)


def _answered_routes(recorder, folder):
    """The route paths `canyonos test` got an answer from."""
    call = canyonos(
        recorder, ["test", "--json"], cwd=folder, timeout=TEST_TIMEOUT, check=False
    )
    assert call.code == 0, call.output
    return sorted(r["url"].split("/", 3)[3] for r in call.json()["results"])


def test_two_projects_share_a_deployment_and_sync_one(recorder, deployment):
    canyonos(
        recorder,
        ["deploy", *PROJECTS, "--folder", deployment.name],
        cwd=deployment.parent,
        timeout=DEPLOY_TIMEOUT,
    )
    routes = [f"{name}/Workflow/main" for name in PROJECTS]
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
            "/workspace/beta/config/workflow_config.yaml",
        ],
        check=False,
    )
    assert kept.code == 0, "syncing alpha removed beta from the deployment"
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
            "/workspace/beta/config/workflow_config.yaml",
        ],
        check=False,
    )
    assert dropped.code != 0, "redeploying alpha alone kept beta in the deployment"
    assert _answered_routes(recorder, deployment) == ["alpha/Workflow/main"]
