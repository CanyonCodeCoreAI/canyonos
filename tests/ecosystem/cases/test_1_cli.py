# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""The CLI flow on a committed port: validate it, then after deploy check the
containers, status and doctor."""

from ..harness import canyonos, docker


def test_validate(recorder, workspace, images):
    call = canyonos(
        recorder, ["validate", ".canyon", "--json"], cwd=workspace, check=False
    )
    assert call.code == 0, call.output


def test_containers_up(recorder, deployed):
    listing = docker(
        recorder,
        [
            "ps",
            "-a",
            "--filter",
            f"label=com.docker.compose.project=canyonos-{deployed.project.name}",
            "--format",
            "{{.Names}}\t{{.State}}",
        ],
    ).output
    states = dict(line.split("\t") for line in listing.splitlines() if "\t" in line)
    expected = [f"canyonos-{deployed.project.name}-global-controller"] + [
        f"canyonos-{deployed.project.name}-{agent.lower()}-0"
        for agent in deployed.agents
    ]
    missing = [name for name in expected if states.get(name) != "running"]
    assert not missing, f"not running: {missing}\n{listing}"
    dashboard = docker(
        recorder,
        ["ps", "--filter", "name=canyonos-dashboard-", "--format", "{{.Names}}"],
    ).output.split()
    assert sorted(dashboard) == [
        "canyonos-dashboard-api-1",
        "canyonos-dashboard-db-1",
        "canyonos-dashboard-web-1",
    ], dashboard


def test_status(recorder, deployed):
    call = canyonos(recorder, ["status"], cwd=deployed.dir)
    assert deployed.endpoint_url.rsplit(":", 1)[-1] in call.output, call.output


def test_doctor(recorder, deployed):
    canyonos(recorder, ["doctor"], cwd=deployed.dir, timeout=300)
