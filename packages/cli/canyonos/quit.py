"""
Logic for `canyonos quit`: full teardown of the project in the current folder.
Stops and removes its Global Controller container AND deletes its /workspace
named volume, so the project files copied into it are discarded too. Also tears
down the shared local dashboard stack (web/api/db) unless another project's
Global Controller is still running. (Use `canyonos stop` to only halt a running
deploy while keeping the containers and files around.)
"""

import os

from canyonos import project, ui
from canyonos.docker_cmd import (
    DOCKER_CLEANUP_TIMEOUT,
    DOCKER_QUICK_TIMEOUT,
    cleanup_docker,
    run_docker,
)
from canyonos.dashboard_stack import _existing_dashboard_port, teardown_dashboard
from canyonos.gc import GCError, post_clean, require_state
from canyonos.init import docker_env


def _container_state(container_id, env):
    """(exists, running), as far as Docker will say.

    An inspect Docker can't answer at all reads as a container that is still
    there and still up, so teardown attempts every removal instead of skipping
    to deleting the state that records what to remove.
    """
    try:
        result = run_docker(
            ["docker", "inspect", "--format", "{{.State.Running}}", container_id],
            timeout=DOCKER_QUICK_TIMEOUT,
            action=f"Inspecting Docker container {container_id[:12]}",
            env=env,
        )
    except RuntimeError:
        return True, True
    if result.returncode != 0:
        return False, False
    return True, result.stdout.strip() == "true"


def run_quit():
    """Tear down the project's container and volume, and the dashboard when no other
    project still uses it; returns what it couldn't.

    Teardown reports rather than raises. It runs both on its own and as the
    first step of `canyonos deploy`, so a resource that won't go away must not
    also block starting over -- the state file is preserved either way, which
    is what makes a later retry possible.
    """
    state = require_state()
    if state is None:
        return []

    container_id = state["container_id"]
    state_path = project.state_path()
    volume = project.workspace_volume()
    dashboard_kept = False
    # The exact engine this deploy's container was created on, not whatever
    # context is active now -- they can differ (see docker_env).
    env = docker_env(state)
    with ui.status("Tearing down..."):
        failures = []
        # A stale record cannot answer /clean, so establish this before making
        # an HTTP request that would otherwise add a full request timeout.
        exists, container_running = _container_state(container_id, env)

        # Stop any running deploy first, so the local controller and Redis
        # containers it spawned via docker-outside-of-docker get torn down
        # too. Removing the GC container itself doesn't touch them -- they're
        # sibling containers on the host, not nested inside it.
        if container_running:
            try:
                post_clean(state["port"])
            except GCError as e:
                # 409 is "no deploy running", which is the desired end state.
                if e.code != 409:
                    failures.append(f"Cleaning the running deployment failed: {e}")

            failure = cleanup_docker(
                ["docker", "stop", container_id],
                action=f"Stopping Global Controller {container_id[:12]}",
                missing_text="No such container",
                timeout=DOCKER_CLEANUP_TIMEOUT,
                env=env,
            )
            if failure:
                failures.append(failure)

        if exists:
            failure = cleanup_docker(
                ["docker", "rm", container_id],
                action=f"Removing Global Controller {container_id[:12]}",
                missing_text="No such container",
                timeout=DOCKER_CLEANUP_TIMEOUT,
                env=env,
            )
            if failure:
                failures.append(failure)

        # Remove the workspace volume only after the container is gone (docker
        # refuses to remove a volume still in use). A missing volume is already
        # the desired end state; every other failure remains retryable.
        failure = cleanup_docker(
            ["docker", "volume", "rm", volume],
            action=f"Removing workspace volume {volume}",
            missing_text="No such volume",
            timeout=DOCKER_CLEANUP_TIMEOUT,
            env=env,
        )
        if failure:
            failures.append(failure)
        if project.other_global_controllers_running(container_id, env):
            dashboard_kept = True
        elif not teardown_dashboard():
            failures.append("Removing the dashboard stack failed")

        if not failures:
            # The controller's gone, so this file would just point commands at a ghost.
            try:
                os.remove(state_path)
            except FileNotFoundError:
                pass
            except OSError as e:
                failures.append(f"Removing CanyonOS state at {state_path} failed: {e}")

    if failures:
        ui.fail("Teardown incomplete:\n- " + "\n- ".join(failures))
        ui.hint(
            f"State was preserved at {state_path}, so `canyonos quit` can be retried."
        )
    elif not exists:
        ui.warn(
            f"Global Controller container {container_id[:12]} was already gone; cleaned up local state."
        )
    else:
        ui.ok(
            f"Global Controller container {container_id[:12]} torn down (volume removed)"
        )
    if dashboard_kept and _existing_dashboard_port() is not None:
        ui.hint(
            "The dashboard was left running because another CanyonOS project is "
            "still deployed. Run `canyonos quit` in that project's folder to remove it."
        )
    return failures
