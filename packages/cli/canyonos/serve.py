# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
CLI output for the local dashboard stack.

Automatically gets created when deploy runs unless --serve flag is set to false.
"""

from canyonos import ui
from canyonos.auth import hash_api_key, machine_api_key, resolve_api_key
from canyonos.constants import dashboard_port, deployment_config_path
from canyonos.gc import deploy_status
from canyonos.init import load_state, redis_port_of
from .dashboard_registration import RegistrationError, register_project
from .dashboard_stack import ServeResult, _existing_dashboard_port, run_dashboard


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
        registered = register_project(redis_port_of(state))
    except RegistrationError as e:
        ui.warn(f"Dashboard could not register this project: {e}")
        ui.hint("Run `canyonos serve` again to retry.")
        return
    ui.ok(f"Registered {registered.get('name', 'this project')} with the dashboard")


def _warn_if_dashboard_port_ignored() -> None:
    """Warn when the dashboard already runs on another port than this project's
    `dashboard_port`, which is then ignored."""
    configured_port = dashboard_port(deployment_config_path())
    running_port = _existing_dashboard_port()
    if configured_port and running_port not in (None, configured_port):
        ui.warn(
            f"The dashboard is already running on {running_port}, so "
            f"`dashboard_port: {configured_port}` is ignored."
        )


def serve_dashboard(
    report_failure: bool = True,
    api_key_hash: str | None = None,
    renewed: tuple[str, ...] = (),
) -> ServeResult:
    """Bring the dashboard up, reporting progress, with its API checking the API key
    whose hash is `api_key_hash` (by default this machine's key), and the `renewed`
    services in new containers. Returns the stack's result.

    Phases drive the spinner while the stack comes up; the trace itself is
    only printed when something fails and the user needs to see how far it got.
    """
    trace = []
    configured_port = dashboard_port(deployment_config_path())
    if api_key_hash is None:
        api_key_hash = hash_api_key(machine_api_key())

    with ui.status("Starting the dashboard...") as spinner:

        def report(phase: str, message: str) -> None:
            trace.append((phase, message))
            spinner.update(message)

        result = run_dashboard(report, configured_port, api_key_hash, renewed)

    if result.ok:
        _warn_if_dashboard_port_ignored()
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


def run_serve(api_key: str | None = None, no_api_key: bool = False) -> int:
    """Run `canyonos serve`: start the dashboard, its API in a new container that
    checks this machine's API key, which `api_key` sets or replaces and `no_api_key`
    removes, and show its URL in the terminal. Returns 0 or 1."""
    key = resolve_api_key(api_key, no_api_key)
    result = serve_dashboard(api_key_hash=hash_api_key(key), renewed=("api",))
    if not result.ok:
        return 1

    ui.ok(f"Dashboard: {result.url}")
    return 0
