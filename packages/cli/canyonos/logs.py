# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
Logic for `canyonos logs`: re-subscribe to the running deploy's log stream.
"""

from canyonos import ui
from canyonos.api import (
    NoDeployError,
    controller_log,
    deployed_logs,
    require_state,
    workflow_group_status,
)


def run_logs(follow=True, tail="200", agent=None):
    """Run `canyonos logs`: print the last `tail` lines of the deploy's Global Controller
    log and, with `follow`, keep streaming it until Ctrl-C or the deploy exits; with
    `agent`, print that agent's or replica's last `tail` lines instead. Raises
    NoDeployError when no deploy runs."""
    state = require_state()

    status = workflow_group_status(state)
    if status is None:
        raise NoDeployError(
            "Nothing is running for this workflow group. Run `canyonos stop` to clean up."
        )

    if not status.get("running"):
        raise NoDeployError(
            "No workflow group is running. Run `canyonos deploy` first."
        )

    if agent:
        # The API takes an agent by its ID, which the status lists; anything else is a replica's.
        agent_id = next(
            (
                listed["agent_id"]
                for listed in status.get("agents") or []
                if listed["name"] == agent
            ),
            None,
        )
        replica_logs = deployed_logs(state, agent_id or agent, tail)
        ui.json_result["logs"] = replica_logs
        if not replica_logs:
            ui.warn(f"{agent} has no running replicas.")
        for replica_id, lines in replica_logs.items():
            ui.say(f"--- {replica_id} ---")
            print("\n".join(lines))
        return True

    if not follow:
        log = "".join(controller_log(state, tail))
        ui.json_result["logs"] = {"global-controller": log.splitlines()}
        print(log, end="")
        return True

    try:
        for line in controller_log(state, tail, follow):
            print(line, end="", flush=True)
    except KeyboardInterrupt:
        ui.blank()
        ui.say(
            "Stopped monitoring log stream. Run `canyonos stop` to stop the workflow group."
        )
    return True
