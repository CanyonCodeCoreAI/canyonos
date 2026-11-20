# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""The CanyonOS API around a real deploy of the bundled Hello World: every command
that runs or reads a deploy goes through it, so each must find it again when it is
gone. A deploy registers with the dashboard before its upload, and `canyonos status`,
`logs` and `sync` start a stopped API again; `canyonos stop` and `sync` bring back a
removed one, which then serves them from what it stored; a rebuilt API image, or a
control key the running API was not started with, has the next command that runs a
deploy replace the API, while `status` names the control key file and the fix; and an
API image that is nowhere stops a deploy before it starts anything, naming the image
and the variable that picks it.

Each case has its own HOME, but the API's container name, ports and the Docker engine
are the machine's, so every case tears its deploy down whether or not it passed."""

from __future__ import annotations

import json
import os
import secrets
import subprocess
from pathlib import Path

import yaml

from .harness import (
    API_CONTAINER,
    DOCKER,
    REGISTERED,
    STARTER,
    deploy_starter,
    docker,
    needs_a_runtime,
    run_ok,
    runtime_environment,
    workflow_config_dir,
    workflow_group_id,
)

DEPLOY_TIMEOUT = 600
# An image tag no registry has, so pulling it fails wherever the case runs.
MISSING_API_IMAGE = "canyonos-api:does-not-exist"


def _api_running() -> bool:
    return docker("inspect", "--format", "{{.State.Running}}", API_CONTAINER) == "true"


def _api_container() -> tuple[str, str]:
    """The API container's id and the id of the image it runs."""
    container_id, image_id = docker(
        "inspect", "--format", "{{.Id}} {{.Image}}", API_CONTAINER
    ).split()
    return container_id, image_id


def _containers_of(case, folder: Path) -> list[str]:
    """Every container, running or not, of the workflow group deployed from `folder`:
    each one's name holds the start of its workflow_group_id."""
    prefix = workflow_group_id(case, folder)[:8]
    names = docker("ps", "-a", "--filter", f"name={prefix}", "--format", "{{.Names}}")
    return names.split()


def _said(result) -> str:
    return " ".join((result.stdout + result.stderr).split())


def _controller_view(case, folder: Path, workflow: str) -> str:
    """What the Global Controller of the workflow group deployed from `folder` holds of
    `workflow`'s config, with its files' times, and the end of its log: for a case that
    finds the deploy not as it synced it."""
    [controller] = docker(
        "ps",
        "-q",
        "--filter",
        "label=canyonos.role=global-controller",
        "--filter",
        f"label=canyonos.workflow_group_id={workflow_group_id(case, folder)}",
    ).split()
    config = f"/workspace/{workflow}/config"
    held = docker(
        "exec",
        controller,
        "sh",
        "-c",
        f"ls -la --time-style=full-iso {config}; cat {config}/workflow_config.yaml",
    )
    log = subprocess.run(
        ["docker", "logs", "--timestamps", "--tail", "80", controller],
        capture_output=True,
        text=True,
        timeout=60,
        env={**os.environ, **DOCKER},
    )
    return f"{held}\n{log.stdout}{log.stderr}"


def _status(case, folder: Path) -> dict:
    """`canyonos status --json` from `folder`, whatever it exits with."""
    shown = case.run_cli(
        ["status", "--json"],
        timeout=DEPLOY_TIMEOUT,
        env=runtime_environment(),
        cwd=folder,
    )
    return {"code": shown.returncode, **json.loads(shown.stdout)}


@needs_a_runtime
def test_a_deploy_registers_first_and_commands_start_a_stopped_api(
    deployed_workflow,
):
    """A deploy without the dashboard registers the workflow group with it before the
    upload, and `canyonos status`, `logs` and `sync` each start the CanyonOS API again
    after it was stopped, then answer from it."""
    case, folder = deployed_workflow
    _, output = deploy_starter(case, folder)
    registered = REGISTERED.search(output)
    assert registered, output
    assert registered.start() < output.index("Sync complete."), output

    for command in (["status"], ["logs", "--no-follow"], ["sync", STARTER]):
        docker("stop", API_CONTAINER)
        shown = run_ok(
            case,
            command,
            timeout=DEPLOY_TIMEOUT,
            env=runtime_environment(),
            cwd=folder,
        )
        running = docker("inspect", "--format", "{{.State.Running}}", API_CONTAINER)
        assert running == "true", f"{command} left the API stopped: {shown}"


@needs_a_runtime
def test_stop_brings_back_a_removed_api_and_stops_the_deploy(deployed_workflow):
    """With the API's container gone, not only stopped, `canyonos stop` makes it again
    and has it stop the deploy: nothing of the workflow group is left, and the API's
    container is back, stopped with the rest of the dashboard after the last workflow
    group's stop."""
    case, folder = deployed_workflow
    deploy_starter(case, folder)
    assert _containers_of(case, folder), "the deploy started no container"
    docker("rm", "--force", API_CONTAINER)

    stopped = run_ok(
        case, ["stop"], timeout=DEPLOY_TIMEOUT, env=runtime_environment(), cwd=folder
    )

    assert "Starting the CanyonOS API" in stopped, stopped
    assert docker("ps", "-a", "--filter", f"name=^{API_CONTAINER}$", "-q"), (
        f"stop did not make the API's container again: {stopped}"
    )
    left = _containers_of(case, folder)
    assert not left, f"stop left {left}"
    status = _status(case, folder)
    assert status["code"] == 3 and status["running"] is False, status


@needs_a_runtime
def test_sync_goes_through_a_recreated_api(deployed_workflow):
    """A config change, made in the config the workflow group's record keeps for the
    workflow, synced while the API's container is gone reaches the deploy through the
    API `canyonos sync` makes again, which knows the workflow group from what it
    stored."""
    case, folder = deployed_workflow
    deploy_starter(case, folder)
    config = workflow_config_dir(case, folder / STARTER) / "workflow_config.yaml"
    manifest = yaml.safe_load(config.read_text())
    [hello] = [agent for agent in manifest["agents"] if agent["name"] == "HelloAgent"]
    hello["replicas"] = 2
    config.write_text(yaml.safe_dump(manifest, sort_keys=False))
    docker("rm", "--force", API_CONTAINER)

    synced = run_ok(
        case,
        ["sync", STARTER],
        timeout=DEPLOY_TIMEOUT,
        env=runtime_environment(),
        cwd=folder,
    )

    assert "Sync complete." in synced, synced
    assert _api_running(), "sync did not bring the API back"
    status = _status(case, folder)
    agents = status["agents"] or []
    hello = [agent for agent in agents if agent["name"].endswith(".HelloAgent")]
    [workflow] = {route["workflow"] for route in status["endpoint"]["routes"]}
    assert [agent["desired_replicas"] for agent in hello] == [2], (
        f"{synced}\n{json.dumps(status)}\n{_controller_view(case, folder, workflow)}"
    )


@needs_a_runtime
def test_a_rebuilt_api_image_replaces_the_running_api(deployed_workflow):
    """The API image rebuilt under the same name, as `bun run canyonos:dev` does, is
    what the next command that runs a deploy brings the API up on: `canyonos sync`
    replaces the running API with one from the new image, which then serves it."""
    case, folder = deployed_workflow
    deploy_starter(case, folder)
    before, old_image = _api_container()
    image = docker("inspect", "--format", "{{.Config.Image}}", API_CONTAINER)
    # A new image of the same content under the same name, without a build: a
    # container is never started, so only the label differs.
    scratch = docker("create", image)
    try:
        docker(
            "commit",
            "--change",
            f"LABEL canyonos.e2e.rebuilt={secrets.token_hex(4)}",
            scratch,
            image,
        )
    finally:
        docker("rm", scratch)
    new_image = docker("image", "inspect", "--format", "{{.Id}}", image)
    try:
        assert new_image != old_image, "the commit kept the image's id"
        synced = run_ok(
            case,
            ["sync", STARTER],
            timeout=DEPLOY_TIMEOUT,
            env=runtime_environment(),
            cwd=folder,
        )
        after, running_image = _api_container()
    finally:
        # Later cases deploy with the image as the run built it.
        docker("tag", old_image, image)

    assert after != before, f"sync kept the API on the old image: {synced}"
    assert running_image == new_image, (running_image, new_image)


@needs_a_runtime
def test_status_names_the_control_key_until_stop_restarts_the_api(deployed_workflow):
    """A control key in `~/.canyonos/control_key` that the running API was not started
    with: `canyonos status`, which never replaces a running API, fails and says to
    restart it with that file's key; `canyonos stop` restarts it itself and stops the
    deploy."""
    case, folder = deployed_workflow
    deploy_starter(case, folder)
    control_key = case.home / ".canyonos" / "control_key"
    assert control_key.is_file(), "the deploy made no control key"
    control_key.write_text(secrets.token_urlsafe(32) + "\n")

    refused = case.run_cli(
        ["status"], timeout=DEPLOY_TIMEOUT, env=runtime_environment(), cwd=folder
    )

    said = _said(refused)
    assert refused.returncode == 1, said
    assert "this machine's control key" in said, said
    assert str(control_key) in said and "`canyonos serve`" in said, said
    assert "Traceback" not in said, said
    run_ok(
        case, ["stop"], timeout=DEPLOY_TIMEOUT, env=runtime_environment(), cwd=folder
    )
    left = _containers_of(case, folder)
    assert not left, f"stop left {left}"


@needs_a_runtime
def test_a_missing_api_image_stops_the_deploy_naming_it(deployed_workflow):
    """An API image this machine lacks and no registry has: the deploy exits 1 before
    it creates anything, saying the API could not start, which image is missing and
    which variable picks it, with no traceback."""
    case, folder = deployed_workflow

    refused = case.run_cli(
        ["deploy", STARTER, "--serve", "false"],
        timeout=DEPLOY_TIMEOUT,
        env={**runtime_environment(), "CANYONOS_API_IMAGE": MISSING_API_IMAGE},
        cwd=folder,
    )

    said = _said(refused)
    assert refused.returncode == 1, said
    assert "Could not start the CanyonOS API" in said, said
    assert f"{MISSING_API_IMAGE} is not on this machine" in said, said
    assert "CANYONOS_API_IMAGE" in said, said
    assert "Traceback" not in said, said
    assert not _containers_of(case, folder), "the deploy started a container"
