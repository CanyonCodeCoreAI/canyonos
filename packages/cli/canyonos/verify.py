# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
The agent readiness table behind `canyonos doctor`.

It checks the running deployment's agents, as its Global Controller reports them,
-- every image built, every replica up -- because the controller logs a warning
and carries on when an agent never becomes healthy, so a workflow that answers
is not on its own proof that the deploy is complete.
"""

import subprocess

from rich.table import Table

from canyonos import deployment
from canyonos.theme import GREEN

# The endpoint's replica, which runs the CanyonOS image rather than one the deploy builds.
ENDPOINT_AGENT_NAME = "endpoint"


def _built_images():
    result = subprocess.run(
        ["docker", "images", "--format", "{{.Repository}}"],
        capture_output=True,
        encoding="utf-8",
        errors="replace",
    )
    return set(result.stdout.split())


def _runtime_table(rows):
    """Build a table of each agent's running state, shown in the terminal by `canyonos
    doctor`, with failing agents in red."""
    table = Table(
        border_style=GREEN, header_style=f"bold {GREEN}", title_style=f"bold {GREEN}"
    )
    for column in ("Agent", "Image", "Replicas"):
        table.add_column(column)
    for row in rows:
        replicas = f"{row['running']}/{row['expected']}"
        style = "" if row["ok"] else "bold red"
        table.add_row(
            row["name"],
            row["image"] if row["image_built"] else f"{row['image']} (missing)",
            replicas,
            style=style,
        )
    return table


def agent_rows(runtime):
    """Per-agent readiness rows for the agents a running deployment's Global Controller
    reports in `runtime` (its `/runtime_status`): image built, replicas running. Pure
    data -- no printing, nothing raised."""
    images = _built_images()
    rows = []
    for name, agent in runtime["agents"].items():
        if name == ENDPOINT_AGENT_NAME:
            continue
        image = deployment.image_name(name)
        expected = agent["desired_replicas"] or 0
        running = agent["running_replicas"]
        image_built = image in images
        rows.append(
            {
                "name": name,
                "image": image,
                "image_built": image_built,
                "expected": expected,
                "running": running,
                "ok": image_built and running >= expected,
            }
        )
    return rows
