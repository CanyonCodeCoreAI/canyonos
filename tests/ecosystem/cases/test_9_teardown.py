# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""`canyonos stop` from the project leaves no container of the project behind.
This runs last; the container logs are collected first, because stop removes
them."""

from ..harness import canyonos, collect_container_logs, docker


def test_stop_cleans_up(recorder, deployed, artifacts_dir):
    collect_container_logs(recorder, artifacts_dir / "containers")
    canyonos(recorder, ["stop"], cwd=deployed.dir, timeout=600)
    leftovers = docker(
        recorder,
        [
            "ps",
            "-a",
            "--filter",
            f"label=com.docker.compose.project=canyonos-{deployed.project.name}",
            "--format",
            "{{.Names}}",
        ],
    ).output.split()
    assert not leftovers, leftovers
