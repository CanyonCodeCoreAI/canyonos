# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
Logic for `canyonos stop`: stop the running deploy inside the current project's
Global Controller container (SIGTERM, same teardown as Ctrl+C would trigger).
"""

from canyonos import project, ui
from canyonos.dashboard_stack import _existing_dashboard_port, stop_dashboard
from canyonos.gc import GCError, deploy_status, post_clean, require_state
from canyonos.init import docker_env


def run_stop():
    """Run `canyonos stop`: shut down the project's running agents, and the dashboard
    when no other project still uses it, but leave CanyonOS's own container and files
    in place for the next deploy. `canyonos quit` removes those too. Returns True when
    nothing is left running."""
    state = require_state()
    if state is None:
        return True
    if deploy_status(state["port"]) is None:
        ui.warn("Nothing is running for this project. Run `canyonos quit` to clean up.")
        return False

    try:
        with ui.status("Stopping deploy..."):
            try:
                post_clean(state["port"])
            except GCError as e:
                # 409 is "no deploy running", which is the desired end state.
                if e.code != 409:
                    raise
            dashboard_kept = project.other_global_controllers_running(
                state["container_id"], docker_env(state)
            )
            dashboard_stopped = not dashboard_kept and stop_dashboard()
    except GCError as e:
        ui.fail(e)
        return False

    if dashboard_kept:
        ui.ok("Deploy stopped.")
        if _existing_dashboard_port() is not None:
            ui.hint(
                "The dashboard was left running because another CanyonOS project is "
                "still deployed."
            )
        return True
    if dashboard_stopped:
        ui.ok("Deploy stopped.")
    else:
        ui.warn(
            "Deploy stopped, but the dashboard did not. Run `canyonos quit` to remove it."
        )
    return dashboard_stopped
