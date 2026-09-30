"""
Logic for `canyonos stop`: stop the running deploy inside the Global
Controller container (SIGTERM, same teardown as Ctrl+C would trigger).
"""

from canyonos import ui
from canyonos.dashboard_stack import stop_dashboard
from canyonos.gc import GCError, post_clean, require_state


def run_stop():
    """Run `canyonos stop`: shut down the running agents and the dashboard, but leave
    CanyonOS's own container and files in place for the next deploy. `canyonos quit`
    removes those too."""
    state = require_state()
    if state is None:
        return

    try:
        with ui.status("Stopping deploy..."):
            post_clean(state["port"])
            dashboard_stopped = stop_dashboard()
    except GCError as e:
        ui.fail(e)
        return

    if dashboard_stopped:
        ui.ok("Deploy stopped.")
    else:
        ui.warn(
            "Deploy stopped, but the dashboard did not. Run `canyonos quit` to remove it."
        )
