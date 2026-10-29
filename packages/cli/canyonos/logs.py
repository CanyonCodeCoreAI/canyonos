# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
Logic for `canyonos logs`: re-subscribe to the running deploy's log stream.
"""

import subprocess

from canyonos import project, ui
from canyonos.gc import deploy_status, deployed_logs, require_state
from canyonos.init import docker_env


def run_logs(follow=True, tail="200", agent=None):
    """Run `canyonos logs`: print the last `tail` lines of the deploy's Global Controller
    logs and, with `follow`, keep streaming them until Ctrl-C; with `agent`, print that
    agent's or replica's last `tail` lines instead. Returns False when no deploy is recorded."""
    state = require_state()
    if state is None:
        return False

    status = deploy_status(state["port"])
    if status is None:
        raise RuntimeError(
            "Nothing is running for this project. Run `canyonos stop` to clean up."
        )

    if not status.get("running"):
        raise RuntimeError("No deploy is running. Run `canyonos deploy` first.")

    if agent:
        replica_logs = deployed_logs(state["port"], agent, tail)
        if not replica_logs:
            ui.warn(f"{agent} has no running replicas.")
        for replica_id, lines in replica_logs.items():
            ui.say(f"--- {replica_id} ---")
            print("\n".join(lines))
        return True

    try:
        result = subprocess.run(
            [
                "docker",
                "logs",
                *(["-f"] if follow else []),
                "--tail",
                tail,
                project.gc_container_name(),
            ],
            env=docker_env(state),
        )
    except KeyboardInterrupt:
        ui.blank()
        ui.say("Stopped monitoring log stream. Run `canyonos stop` to stop the deploy.")
        return True
    if result.returncode != 0:
        raise RuntimeError(
            f"Docker log stream failed with exit code {result.returncode}. "
            "Run `canyonos status` to check the deploy."
        )
    return True
