# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
CLI output for the local dashboard stack.

Automatically gets created when deploy runs unless --serve flag is set to false.
"""

from canyonos import ui
from canyonos.constants import dashboard_port, default_config_path, local_redis_port
from canyonos.gc import deploy_status
from canyonos.init import load_state
from .dashboard_registration import RegistrationError, register_project
from .dashboard_stack import ServeResult, run_dashboard


def _register_running_project() -> None:
    """Register this folder's project with the dashboard when its controller is running.

    Temporary: applied now so multi-project dashboards work without blocking the flow;
    revisit with the project-key design in CAN-521 (the api should not hold
    per-project Redis addresses).

    A folder with no readable deploy state or no running deploy has nothing to
    register, so it is skipped without a word. A failed registration only
    warns: the dashboard is up either way.
    """
    try:
        state = load_state()
    except (FileNotFoundError, RuntimeError):
        return
    if not (deploy_status(state["port"]) or {}).get("running", False):
        return

    try:
        registered = register_project(local_redis_port(default_config_path()))
    except RegistrationError as e:
        ui.warn(f"Dashboard could not register this project: {e}")
        ui.hint("Run `canyonos serve` again to retry.")
        return
    ui.ok(f"Registered {registered.get('name', 'this project')} with the dashboard")


def serve_dashboard(report_failure: bool = True) -> ServeResult:
    """Bring the dashboard up, reporting progress. Returns the stack's result.

    Phases drive the spinner while the stack comes up; the trace itself is
    only printed when something fails and the user needs to see how far it got.
    """
    trace = []
    preferred_port = dashboard_port(default_config_path())

    with ui.status("Starting the dashboard...") as spinner:

        def report(phase: str, message: str) -> None:
            trace.append((phase, message))
            spinner.update(message)

        result = run_dashboard(report, preferred_port)

    if result.ok:
        _register_running_project()
        return result
    if not report_failure:
        return result

    for phase, message in trace:
        ui.hint(f"{phase}: {message}")
    ui.fail(f"serve failed in {result.phase}: {result.message}")
    if result.log_path:
        ui.hint(f"log: {result.log_path}")
    return result


def run_serve() -> int:
    """Run `canyonos serve`: start the dashboard and show its URL in the terminal.
    Returns 0 or 1."""
    result = serve_dashboard()
    if not result.ok:
        return 1

    ui.ok(f"Dashboard: {result.url}")
    return 0
