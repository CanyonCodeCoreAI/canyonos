# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""`canyonos stop` removes the project's containers, its workspace volume and its
records under `~/.canyonos`; a second stop is a no-op and `canyonos status` then
reports nothing running. `canyonos clean` removes the agents' images and, for a
port, `.canyon`. This runs last; the container logs are collected first, because
stop removes them. What stop does to the shared dashboard is
scenarios/test_shared_dashboard.py's.

Each run stages the project under a new project id, so its images get new names;
the clean here is the run's final teardown and keeps them from piling up."""

from pathlib import Path

from ..harness import (
    canyonos,
    cli_value,
    collect_container_logs,
    docker,
    manifest,
    project_containers,
    stop_project,
)


def _volume_exists(recorder, volume):
    return docker(recorder, ["volume", "inspect", volume], check=False).code == 0


def test_stop_removes_the_project_and_its_records(recorder, deployed, artifacts_dir):
    collect_container_logs(recorder, artifacts_dir / "containers")
    state, volume = cli_value(
        recorder,
        deployed.dir,
        "[state_path(), workspace_volume()]",
        "from canyonos.project import state_path, workspace_volume",
    )
    records = [Path(state), Path(state).parent / "deployed.json"]
    assert all(path.is_file() for path in records), records
    assert _volume_exists(recorder, volume), f"no workspace volume {volume}"

    stop = stop_project(recorder, deployed.dir)
    assert stop is not None and stop.code == 0, stop and stop.output

    leftovers = project_containers(recorder, deployed.group, every=True)
    assert not leftovers, leftovers
    assert not _volume_exists(recorder, volume), f"{volume} is still there"
    kept = [path for path in records if path.exists()]
    assert not kept, kept
    canyonos(recorder, ["stop"], cwd=deployed.dir, timeout=600)
    status = canyonos(recorder, ["status", "--json"], cwd=deployed.dir, check=False)
    assert status.code != 0, status.output
    assert status.json()["running"] is False, status.stdout


def _images(recorder):
    listing = docker(recorder, ["images", "--format", "{{.Repository}}"]).output
    return set(listing.split())


def test_clean_removes_the_agent_images_and_the_port(recorder, deployed):
    built = {
        f"{deployed.group}-{spec['name'].lower()}"
        for spec in manifest(deployed.dir).get("agents", [])
        if spec.get("type", "agent") != "database"
    }
    missing = sorted(built - _images(recorder))
    assert not missing, f"never built: {missing}"
    canyon = deployed.dir / ".canyon"
    if deployed.project.port is not None:
        assert canyon.is_dir(), canyon

    canyonos(recorder, ["clean"], cwd=deployed.dir, timeout=600)

    left = sorted(built & _images(recorder))
    assert not left, left
    if deployed.project.port is not None:
        assert not canyon.exists(), canyon
