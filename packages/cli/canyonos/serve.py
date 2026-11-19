# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
CLI output for the local stack: the CanyonOS API every command that runs or reads a
deploy here goes through, and the dashboard's web app, which a deploy also starts
unless --serve is set to false.
"""

from canyonos import env, ui
from canyonos.api import (
    ApiError,
    forget_api_url,
    is_running,
    probe,
    workflow_group_status,
)
from canyonos.auth import (
    control_key_hash,
    hash_api_key,
    machine_api_key,
    resolve_api_key,
)
from canyonos.constants import dashboard_port, deployment_config_path
from canyonos.docker_cmd import DOCKER_QUICK_TIMEOUT, run_docker
from canyonos.init import docker_env, load_state
from .dashboard_registration import RegistrationError, register_workflows
from .dashboard_stack import (
    API_SERVICES,
    STACK_SERVICES,
    PhaseFailure,
    ServeResult,
    _dashboard_lock,
    dashboard_api_key_hash,
    dashboard_control_key_hash,
    run_dashboard,
    running_api_image,
    running_api_port,
    running_web_port,
)


def _register_running_workflows() -> None:
    """Register this folder's workflows with the dashboard when its controller is running.

    Temporary: applied now so multi-workflow dashboards work without blocking the flow;
    revisit with the workflow-key design in CAN-521 (the api should not hold
    per-workflow Redis addresses).

    A folder with no readable deploy state or no running deploy has nothing to
    register, so it is skipped without a word. A failed registration only
    warns: the dashboard is up either way.
    """
    try:
        state = load_state()
    except (FileNotFoundError, RuntimeError):
        return
    try:
        running = is_running(workflow_group_status(state))
    except ApiError as e:
        ui.warn(f"Dashboard could not register this workflow group: {e}")
        return
    if not running:
        return

    try:
        registered = register_workflows(state)
    except RegistrationError as e:
        ui.warn(f"Dashboard could not register this workflow group: {e}")
        ui.hint("Run `canyonos serve` again to retry.")
        return
    names = ", ".join(workflow["name"] for workflow in registered)
    ui.ok(f"Registered {names} with the dashboard")


def _warn_if_dashboard_port_ignored() -> None:
    """Warn when the dashboard already runs on another port than this workflow group's
    `dashboard_port`, which is then ignored."""
    configured_port = dashboard_port(deployment_config_path())
    running_port = running_web_port()
    if configured_port and running_port not in (None, configured_port):
        ui.warn(
            f"The dashboard is already running on {running_port}, so "
            f"`dashboard_port: {configured_port}` is ignored."
        )


def serve_dashboard(
    report_failure: bool = True,
    api_key_hash: str | None = None,
    renewed: tuple[str, ...] = (),
    services: tuple[str, ...] = STACK_SERVICES,
) -> ServeResult:
    """Bring `services` of the local stack up, reporting progress, with its API
    checking the API key whose hash is `api_key_hash` (by default this machine's key),
    and the `renewed` services in new containers. Returns the stack's result; with the
    web app among `services`, this folder's running workflows are registered with it.

    Phases drive the spinner while the stack comes up; the trace itself is
    only printed when something fails and the user needs to see how far it got.
    """
    trace = []
    configured_port = dashboard_port(deployment_config_path())
    if api_key_hash is None:
        api_key_hash = hash_api_key(machine_api_key())
    starting = (
        "Starting the dashboard..."
        if "web" in services
        else "Starting the CanyonOS API..."
    )

    with ui.status(starting) as spinner:

        def report(phase: str, message: str) -> None:
            trace.append((phase, message))
            spinner.update(message)

        result = run_dashboard(
            report, configured_port, api_key_hash, renewed, services=services
        )
    # It may have moved to another port.
    forget_api_url()

    if result.ok:
        if "web" in services:
            _warn_if_dashboard_port_ignored()
            _register_running_workflows()
        return result
    if not report_failure:
        return result

    for phase, message in trace:
        ui.hint(f"{phase}: {message}")
    ui.fail(f"serve failed in {result.phase}: {result.message}")
    if result.log_path:
        ui.hint(f"log: {result.log_path}")
    return result


def _image_id(image: str) -> str | None:
    """The ID of `image` on this machine, or None when it is not here."""
    try:
        result = run_docker(
            ["docker", "image", "inspect", "--format", "{{.Id}}", image],
            timeout=DOCKER_QUICK_TIMEOUT,
            action=f"Inspecting image {image}",
        )
    except RuntimeError:
        return None
    if result.returncode != 0:
        return None
    return result.stdout.strip() or None


def _api_is_current(api_key_hash: str) -> bool:
    """True when the running CanyonOS API checks the API key whose hash is
    `api_key_hash` and this machine's control key, and runs the image this CLI uses."""
    return (
        dashboard_api_key_hash() == api_key_hash
        and dashboard_control_key_hash() == control_key_hash()
        and running_api_image() == _image_id(env.api_image)
    )


def _start_api(api_key_hash: str, renewed: tuple[str, ...]) -> None:
    """Bring up the database and the CanyonOS API, `renewed` in new containers; raise
    RuntimeError when they can't start."""
    result = serve_dashboard(
        report_failure=False,
        api_key_hash=api_key_hash,
        renewed=renewed,
        services=API_SERVICES,
    )
    if not result.ok:
        logs = f" Its logs are in {result.log_path}." if result.log_path else ""
        raise RuntimeError(f"Could not start the CanyonOS API: {result.message}.{logs}")


def ensure_api(api_key_hash: str | None = None) -> bool:
    """Bring up the database and the CanyonOS API for a command that runs or stops a
    deploy on Docker, with the API checking the API key whose hash is `api_key_hash`
    (by default this machine's key): one running on that key, this machine's control
    key and the image this CLI uses is kept, else it starts in a new container. Then
    check it answers `/v1`. Returns whether the API was down; raises RuntimeError when
    it can't start or answers no `/v1`."""
    if api_key_hash is None:
        api_key_hash = hash_api_key(machine_api_key())
    try:
        with _dashboard_lock():
            api_up = running_api_port() is not None
            current = api_up and _api_is_current(api_key_hash)
    except PhaseFailure as failure:
        raise RuntimeError(failure.message) from None
    if not current:
        _start_api(api_key_hash, renewed=("api",))
    probe()
    return not api_up


def _controller_exists(state: dict) -> bool:
    """True when the Global Controller container `state` records is on the Docker
    engine it was created on."""
    try:
        result = run_docker(
            [
                "docker",
                "container",
                "inspect",
                "--format",
                "{{.Id}}",
                state["container_id"],
            ],
            timeout=DOCKER_QUICK_TIMEOUT,
            action="Inspecting the Global Controller container",
            env=docker_env(state),
        )
    except RuntimeError:
        return False
    return result.returncode == 0


def start_api_if_down(state: dict) -> None:
    """For a command that only reads a deploy: start the CanyonOS API, as it was last
    started, when it is down and the Global Controller container `state` records is
    on this machine; a running API is never replaced, since another command may be
    using it. One that won't start only warns: the request that follows says it can't
    reach it."""
    try:
        with _dashboard_lock():
            if running_api_port() is not None or not _controller_exists(state):
                return
            api_key_hash = dashboard_api_key_hash()
    except PhaseFailure:
        return
    if api_key_hash is None:
        api_key_hash = hash_api_key(machine_api_key())
    try:
        _start_api(api_key_hash, renewed=())
    except RuntimeError as e:
        ui.warn(str(e))


def run_serve(api_key: str | None = None, no_api_key: bool = False) -> int:
    """Run `canyonos serve`: start the dashboard, with the database and the CanyonOS
    API, its API in a new container that checks this machine's API key, which
    `api_key` sets or replaces and `no_api_key` removes, register this folder's running
    deploy, and show the dashboard's URL in the terminal. Returns 0 or 1."""
    key = resolve_api_key(api_key, no_api_key)
    result = serve_dashboard(api_key_hash=hash_api_key(key), renewed=("api",))
    if not result.ok:
        return 1

    ui.ok(f"Dashboard: {result.url}")
    return 0
