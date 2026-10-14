# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
Logic for `canyonos logs`: re-subscribe to the running deploy's log stream.
"""

import subprocess

from canyonos import project, ui
from canyonos.gc import deploy_status, require_state
from canyonos.init import docker_env


def run_logs():
    """Run `canyonos logs`: stream the deploy's Global Controller logs until Ctrl-C."""
    state = require_state()
    if state is None:
        raise RuntimeError("No Global Controller container is available for logs.")

    status = deploy_status(state["port"])
    if status is None:
        raise RuntimeError("Could not reach Global Controller container.")

    if not status.get("running"):
        raise RuntimeError("No deploy is running. Run `canyonos deploy` first.")

    try:
        result = subprocess.run(
            ["docker", "logs", "-f", project.gc_container_name()],
            env=docker_env(state),
        )
    except KeyboardInterrupt:
        ui.blank()
        ui.say("Stopped monitoring log stream. Run `canyonos stop` to stop the deploy.")
        return
    if result.returncode != 0:
        raise RuntimeError(
            f"Docker log stream failed with exit code {result.returncode}. "
            "Run `canyonos status` to check the deploy."
        )
