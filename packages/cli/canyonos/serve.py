# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
CLI output for the local dashboard stack.

Automatically gets created when deploy runs unless --serve flag is set to false.
"""

import os
from pathlib import Path

from canyonos import ui
from canyonos.auth import (
    SKIP_AUTH_WARNING,
    refuse_keys_in_project,
    require_keys,
    trusted_dir,
)
from canyonos.constants import (
    dashboard_port,
    deployment_config_path,
    project_config_path,
    project_root,
)
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
    skip_auth: bool = False,
    auth_dir: Path | None = None,
    renewed: tuple[str, ...] = (),
) -> ServeResult:
    """Bring the dashboard up, reporting progress, with its API trusting the public
    keys in `auth_dir`'s `trusted/` unless `skip_auth`, and the `renewed` services in
    new containers. Returns the stack's result.

    Phases drive the spinner while the stack comes up; the trace itself is
    only printed when something fails and the user needs to see how far it got.
    """
    trace = []
    configured_port = dashboard_port(deployment_config_path())

    with ui.status("Starting the dashboard...") as spinner:

        def report(phase: str, message: str) -> None:
            trace.append((phase, message))
            spinner.update(message)

        result = run_dashboard(
            report, configured_port, skip_auth, trusted_dir(auth_dir), renewed
        )

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


def run_serve(skip_auth: bool = False, auth_dir: Path | None = None) -> int:
    """Run `canyonos serve`: start the dashboard, its API in a new container that
    reads the public keys trusted in `auth_dir` (or verifies nothing with
    `skip_auth`), and show its URL in the terminal. Returns 0 or 1; raises
    RuntimeError before anything starts when no key is trusted, or when it runs in
    a project that holds its keys folder."""
    if os.path.isfile(project_config_path(project_root())):
        refuse_keys_in_project(auth_dir)
    if skip_auth:
        ui.warn(SKIP_AUTH_WARNING)
    else:
        require_keys(auth_dir)
    result = serve_dashboard(skip_auth=skip_auth, auth_dir=auth_dir, renewed=("api",))
    if not result.ok:
        return 1

    ui.ok(f"Dashboard: {result.url}")
    return 0
