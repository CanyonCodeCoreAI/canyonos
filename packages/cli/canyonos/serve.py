"""
CLI output for the local dashboard stack.

Automatically gets created when deploy runs unless --serve flag is set to false.
"""

import re
from dataclasses import replace

from canyonos import ui
from canyonos.constants import dashboard_port, default_config_path
from .dashboard_stack import ServeResult, run_dashboard


def _plain_message(message: str) -> str:
    port = re.search(r"Bind for \S+:(\d+) failed: port is already allocated", message)
    if port:
        return f"port {port.group(1)} is already in use by another process or container"
    return message


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

    result = replace(result, message=_plain_message(result.message))
    if result.ok or not report_failure:
        return result

    for phase, message in trace:
        ui.hint(f"{phase}: {message}")
    ui.fail(f"serve failed in {result.phase}: {result.message}")
    if result.log_path:
        ui.hint(f"log: {result.log_path}")
    return result


def run_serve() -> int:
    result = serve_dashboard()
    if not result.ok:
        return 1

    ui.ok(f"Dashboard: {result.url}")
    return 0
