"""
Logic for `canyonos status`: reports whether a deploy is currently running,
and if so, where the workflow (and, if up, the dashboard) answer.
"""

from canyonos import ui
from canyonos.dashboard_stack import _existing_dashboard_port, dashboard_url
from canyonos.deploy import summary_body
from canyonos.gc import GCError, deploy_status, deployed_endpoint, require_state


def run_status():
    """Run `canyonos status`: show in the terminal whether a deploy is running, where to
    reach it, and how to query it."""
    state = require_state()
    if state is None:
        return

    status = deploy_status(state["port"])
    if not status or not status.get("running"):
        ui.warn("No deploy is currently running.")
        return

    ui.ok("Deploy is running.")

    endpoint = None
    try:
        endpoint = deployed_endpoint(state["port"])
    except GCError:
        ui.warn(
            "Could not read the running deploy's endpoint. Run `canyonos logs` to see why."
        )

    dashboard_port = _existing_dashboard_port()
    ui.blank()
    ui.panel(
        summary_body(
            dashboard_url(dashboard_port) if dashboard_port else None, endpoint
        )
    )
