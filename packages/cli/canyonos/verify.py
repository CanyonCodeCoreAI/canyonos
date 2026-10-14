# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
The verification pass behind `canyonos test`.

`verify_runtime` checks a running local deploy against what the config declared
-- every image built, every replica up -- because the controller logs a warning
and carries on when an agent never becomes healthy, so a workflow that answers
is not on its own proof that the deploy is complete.

This file will also need lots of iteration based on what is needed, will expect it to change alot
"""

import subprocess

from rich.table import Table

from canyonos import project, ui
from canyonos.constants import read_config
from canyonos.theme import GREEN


# ------------------------------------------------------------------ #
#  Runtime                                                            #
# ------------------------------------------------------------------ #


def _built_images():
    result = subprocess.run(
        ["docker", "images", "--format", "{{.Repository}}"],
        capture_output=True,
        text=True,
    )
    return set(result.stdout.split())


def _running_containers():
    result = subprocess.run(
        [
            "docker",
            "ps",
            "--filter",
            f"label={project.PROJECT_LABEL}={project.project_group()}",
            "--format",
            "{{.Names}}",
        ],
        capture_output=True,
        text=True,
    )
    return result.stdout.split()


def _runtime_table(rows):
    """Build a table of each agent's running state, shown in the terminal by `canyonos
    doctor` and `canyonos test`, with failing agents in red."""
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


def agent_rows(config_path):
    """Per-agent readiness rows for the config's declared agents: image built,
    replicas running. Pure data -- no printing, nothing raised, so
    both `verify_runtime` and `canyonos doctor` can build on it.
    """
    config = read_config(config_path)

    images = _built_images()
    containers = _running_containers()

    rows = []
    for agent in config.get("agents") or []:
        name = agent.get("name")
        if not name:
            continue
        image = project.image_name(name)
        expected = int(agent.get("replicas", 1) or 1)
        running = sum(
            1 for i in range(expected) if project.container_name(name, i) in containers
        )
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


def verify_runtime(config_path):
    """Check the running deploy against the config. Raises RuntimeError on a gap."""
    rows = agent_rows(config_path)

    ui.panel(_runtime_table(rows))

    problems = [
        f"{row['name']}: image {row['image']} was never built"
        if not row["image_built"]
        else f"{row['name']}: {row['running']} of {row['expected']} replicas running"
        for row in rows
        if not row["ok"]
    ]
    if problems:
        raise RuntimeError("The deploy is incomplete -- " + "; ".join(problems))
    return {"agents": rows}
