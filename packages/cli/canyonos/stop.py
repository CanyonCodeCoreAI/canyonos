# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
Logic for `canyonos stop`: tear down the deploy of the project in the current folder,
or of every project with --all, found by label whether or not its folder still exists.
Its containers, /workspace volume and network go; its images and `.canyon` stay for a
fast redeploy, and the shared dashboard is stopped with its history kept once no other
project's Global Controller runs. `canyonos deploy` and `canyonos clean` reuse it.
"""

import os
import shutil

from canyonos import project, ui
from canyonos.docker_cmd import (
    DOCKER_CLEANUP_TIMEOUT,
    DOCKER_QUICK_TIMEOUT,
    cleanup_docker,
    run_docker,
)
from canyonos.dashboard_stack import (
    COMPOSE_PROJECT,
    _container_name,
    _existing_dashboard_port,
    stop_dashboard,
    teardown_dashboard,
)
from canyonos.gc import GCError, post_clean, require_state
from canyonos.init import GC_CONTAINER_PORT, docker_env, load_state
from canyonos.usage.consent import is_interactive
from utils.tui import select_menu


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


def stop_project(state):
    """Tear down the project's container and volume, leaving the dashboard; returns
    what it couldn't.

    Teardown reports rather than raises. It runs both on its own and as the
    first step of `canyonos deploy`, so a resource that won't go away must not
    also block starting over -- the state file is preserved either way, which
    is what makes a later retry possible.
    """
    container_id = state["container_id"]
    state_path = project.state_path()
    volume = project.workspace_volume()
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

        if not failures:
            # The controller's gone; state.json goes last so a failed removal can be retried.
            for path in (
                os.path.join(project.state_dir(), "deployed.json"),
                state_path,
            ):
                try:
                    os.remove(path)
                except FileNotFoundError:
                    pass
                except OSError as e:
                    failures.append(f"Removing CanyonOS state at {path} failed: {e}")

    if failures:
        ui.fail("Teardown incomplete:\n- " + "\n- ".join(failures))
        ui.hint(
            f"State was preserved at {state_path}, so `canyonos stop` can be retried."
        )
    elif not exists:
        ui.warn("The deploy was already gone; cleaned up local state.")
    else:
        ui.ok("Deploy torn down")
    return failures


def _list_docker(argv, action):
    """The lines a Docker listing prints, or the failure as a string."""
    try:
        result = run_docker(argv, timeout=DOCKER_QUICK_TIMEOUT, action=action)
    except RuntimeError as e:
        return str(e)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()
        return f"{action} failed: {detail or f'exit code {result.returncode}'}"
    return result.stdout.splitlines()


def _clean_deployments():
    """Ask every running Global Controller to tear down its deploy, as `stop` does, so
    what it started elsewhere (EC2 machines) goes too; returns what it couldn't."""
    listed = _list_docker(
        [
            "docker",
            "ps",
            "-q",
            "--filter",
            f"label={project.ROLE_LABEL}={project.GC_ROLE}",
        ],
        "Listing running Global Controllers",
    )
    if isinstance(listed, str):
        return [listed]
    failures = []
    for container_id in listed:
        published = _list_docker(
            ["docker", "port", container_id, f"{GC_CONTAINER_PORT}/tcp"],
            f"Finding Global Controller {container_id[:12]}'s port",
        )
        if isinstance(published, str) or not published:
            failures.append(
                published or f"Global Controller {container_id[:12]} has no port"
            )
            continue
        try:
            post_clean(published[0].rpartition(":")[2])
        except GCError as e:
            if e.code != 409:
                failures.append(
                    f"Cleaning Global Controller {container_id[:12]}'s deploy "
                    f"failed: {e}"
                )
    return failures


# Containers first: Docker refuses to remove a volume or network still in use.
_PROJECT_RESOURCES = (
    # -v takes each container's anonymous volumes (Redis's /data) with it.
    (["docker", "ps", "-a"], "ID", ["docker", "rm", "-f", "-v"], "containers"),
    (["docker", "volume", "ls"], "Name", ["docker", "volume", "rm"], "volumes"),
    (["docker", "network", "ls"], "Name", ["docker", "network", "rm"], "networks"),
)
# The network every project shared before each got its own; it carries no label.
LEGACY_NETWORK = "canyonos-local"


def _remove_project_resources(projects):
    """Remove every container, volume and network labelled with one of `projects`,
    whether or not its folder still exists; returns what it couldn't. Matched against
    CanyonOS's records, since another Compose stack can also be named `canyonos-...`."""
    groups = {f"canyonos-{name}" for name in projects}
    failures = []
    for listing, field, remove, kind in _PROJECT_RESOURCES:
        listed = _list_docker(
            [
                *listing,
                "--filter",
                f"label={project.PROJECT_LABEL}",
                "--format",
                f'{{{{.{field}}}}} {{{{.Label "{project.PROJECT_LABEL}"}}}}',
            ],
            f"Listing CanyonOS {kind}",
        )
        if isinstance(listed, str):
            failures.append(listed)
            continue
        names = [
            line.split()[0]
            for line in listed
            if len(line.split()) == 2
            and line.split()[1] in groups
            and line.split()[1] != COMPOSE_PROJECT
        ]
        if kind == "networks":
            # A stopped dashboard api keeps its place on each project's network and
            # would not start again on one that is gone.
            for network in names:
                _list_docker(
                    [
                        "docker",
                        "network",
                        "disconnect",
                        "--force",
                        network,
                        _container_name("api"),
                    ],
                    f"Disconnecting the dashboard from {network}",
                )
            names.append(LEGACY_NETWORK)
        if names:
            failure = cleanup_docker(
                [*remove, *names],
                action=f"Removing CanyonOS {kind}",
                missing_text="not found" if kind == "networks" else "No such",
                timeout=DOCKER_CLEANUP_TIMEOUT,
            )
            if failure:
                failures.append(failure)
    return failures


def _remove_state_files(projects):
    """Delete the state files of each of `projects` whose Global Controller is gone from
    the Docker engine it was deployed on; returns what it couldn't. One still there runs
    on an engine this run didn't reach, and its state file is what can still stop it."""
    failures = []
    for name in projects:
        state_path = os.path.join(project.projects_dir(), name, "state.json")
        try:
            state = load_state(state_path)
        except FileNotFoundError:
            continue
        except RuntimeError as e:
            failures.append(str(e))
            continue
        if _container_state(state["container_id"], docker_env(state))[0]:
            failures.append(
                f"`{name}` is still deployed, on another Docker engine. Make that "
                "engine the active one and run this again."
            )
            continue
        # state.json goes last so a failed removal can be retried.
        for path in (
            os.path.join(os.path.dirname(state_path), "deployed.json"),
            state_path,
        ):
            try:
                os.remove(path)
            except FileNotFoundError:
                pass
            except OSError as e:
                failures.append(f"Removing CanyonOS state at {path} failed: {e}")
    return failures


def _unlabelled_leftovers():
    """Names of containers an older CLI started before projects were labelled. They
    are only reported: a name alone can't tell them from someone else's."""
    listed = _list_docker(
        [
            "docker",
            "ps",
            "-a",
            "--format",
            f'{{{{.Names}}}}\t{{{{.Label "{project.PROJECT_LABEL}"}}}}\t'
            '{{.Label "io.x-k8s.kind.cluster"}}',
        ],
        "Listing containers",
    )
    if isinstance(listed, str):
        return []
    return [
        line.split("\t")[0]
        for line in listed
        if line.startswith("canyonos-") and not line.partition("\t")[2].strip()
    ]


# The images CanyonOS ships, under any tag: built from a checkout, or pulled.
_OWN_IMAGES = tuple(
    f"{registry}canyonos-{image}"
    for registry in ("", "ghcr.io/canyoncodecoreai/")
    for image in ("core", "api", "web")
)


def _remove_images(projects):
    """Remove CanyonOS's own images and the agent images of `projects`; returns what it
    couldn't. Removed by name and tag, so another name for the same image (a registry
    copy) keeps it."""
    references = [*_OWN_IMAGES, *(f"canyonos-{name}-*" for name in projects)]
    listed = _list_docker(
        [
            "docker",
            "images",
            *(
                arg
                for reference in references
                for arg in ("--filter", f"reference={reference}")
            ),
            "--format",
            "{{.Repository}}:{{.Tag}}",
        ],
        "Listing CanyonOS images",
    )
    if isinstance(listed, str):
        return [listed]
    images = [image for image in listed if not image.endswith(":<none>")]
    if not images:
        return []
    failure = cleanup_docker(
        ["docker", "image", "rm", *images],
        action="Removing CanyonOS images",
        missing_text="No such image",
        timeout=DOCKER_CLEANUP_TIMEOUT,
    )
    return [failure] if failure else []


def _remove_home():
    """Delete `~/.canyonos`: every project's records, the dashboard's, and the usage
    settings; returns what it couldn't."""
    home = os.path.dirname(project.projects_dir())
    try:
        shutil.rmtree(home)
    except FileNotFoundError:
        pass
    except OSError as e:
        return [f"Removing {home} failed: {e}"]
    return []


def confirm_clean_all():
    """Ask before `clean --all` deletes images, the dashboard's data and `~/.canyonos`;
    True only on a yes."""
    if not is_interactive():
        ui.fail(
            "`clean --all` deletes every CanyonOS image, the dashboard's data and "
            "~/.canyonos, so it asks first. Add --yes to run it without a terminal."
        )
        return False
    ui.say(
        "This removes every CanyonOS project, the dashboard and its data, CanyonOS's "
        "images and ~/.canyonos, which holds every project's records and your usage "
        "settings."
    )
    answer = select_menu(
        [(True, "Yes, remove everything"), (False, "No, keep it")],
        title="Remove CanyonOS from this machine?",
    )
    return answer is True


def stop_all(remove_everything=False):
    """`canyonos stop --all`: tear down every CanyonOS project on this machine, from any
    folder, and stop the dashboard, keeping its history. With `remove_everything`, for
    `canyonos clean --all`, also remove the dashboard and its data, CanyonOS's images
    and `~/.canyonos`, leaving only the CLI to uninstall. Returns True when everything
    was removed."""
    try:
        projects = os.listdir(project.projects_dir())
    except FileNotFoundError:
        projects = []
    with ui.status("Tearing down every CanyonOS project..."):
        failures = []
        if remove_everything:
            if not teardown_dashboard():
                failures.append("Removing the dashboard stack failed")
        elif not stop_dashboard():
            failures.append("Stopping the dashboard failed")
        failures += _clean_deployments()
        failures += _remove_project_resources(projects)
        if not failures:
            failures += _remove_state_files(projects)
        if remove_everything and not failures:
            failures += _remove_images(projects)
        if remove_everything and not failures:
            failures += _remove_home()
    command = "clean --all" if remove_everything else "stop --all"
    if failures:
        ui.fail("Teardown incomplete:\n- " + "\n- ".join(failures))
        ui.hint(f"Run `canyonos {command}` again to retry.")
    elif remove_everything:
        ui.ok("CanyonOS is removed from this machine")
        ui.hint(
            "Uninstall the CLI the way you installed it, such as "
            "`uv tool uninstall canyonos`."
        )
    else:
        ui.ok("Every CanyonOS project is torn down and the dashboard stopped")
    leftovers = _unlabelled_leftovers()
    if leftovers:
        ui.hint(
            "These containers look like an older CanyonOS's but carry no project "
            "label, so they were left in place. If they are, remove them with "
            f"`docker rm -f {' '.join(leftovers)}`."
        )
    return not failures


def run_stop(all_projects=False):
    """Run `canyonos stop`: `stop_project`, then stop the dashboard if no other
    project runs, or `stop_all` with `all_projects`. Returns True when nothing of
    the project is left running."""
    if all_projects:
        return stop_all()
    state = require_state()
    if state is None:
        return True
    failures = stop_project(state)
    with ui.status("Stopping the dashboard..."):
        dashboard_kept = project.other_global_controllers_running(
            state["container_id"], docker_env(state)
        )
        if not dashboard_kept and not stop_dashboard():
            ui.fail("Stopping the dashboard failed")
            return False
    if dashboard_kept and _existing_dashboard_port() is not None:
        ui.hint(
            "The dashboard was left running because another CanyonOS project is "
            "still deployed."
        )
    return not failures
