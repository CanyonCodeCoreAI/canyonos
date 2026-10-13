"""
Logic for `canyonos stop`: stop the running deploy inside the current project's
Global Controller container (SIGTERM, same teardown as Ctrl+C would trigger).
"""

from canyonos import project, ui
from canyonos.dashboard_stack import _existing_dashboard_port, stop_dashboard
from canyonos.gc import GCError, post_clean, require_state
from canyonos.init import docker_env


def run_stop():
    """Run `canyonos stop`: shut down the project's running agents, and the dashboard
    when no other project still uses it, but leave CanyonOS's own container and files
    in place for the next deploy. `canyonos quit` removes those too."""
    state = require_state()
    if state is None:
        return

    try:
        with ui.status("Stopping deploy..."):
            post_clean(state["port"])
            dashboard_kept = project.other_global_controllers_running(
                state["container_id"], docker_env(state)
            )
            dashboard_stopped = not dashboard_kept and stop_dashboard()
    except GCError as e:
        ui.fail(e)
        return

    if dashboard_kept:
        ui.ok("Deploy stopped.")
        if _existing_dashboard_port() is not None:
            ui.hint(
                "The dashboard was left running because another CanyonOS project is "
                "still deployed."
            )
        return
    if dashboard_stopped:
        ui.ok("Deploy stopped.")
    else:
        ui.warn(
            "Deploy stopped, but the dashboard did not. Run `canyonos quit` to remove it."
        )
