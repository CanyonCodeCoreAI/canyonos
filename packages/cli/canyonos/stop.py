# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
Logic for `canyonos stop`: tear down the deploys of the workflow groups it is given or picks
(see selection.py), or of every workflow group with --all, found by label whether or not its
folder still exists.
The CanyonOS API stops a workflow group's Global Controller, so on Docker it comes up
first. Its containers, /workspace volume and network go; its images and `.canyon` stay
for a fast redeploy, and the shared dashboard is stopped with its history kept once no
other workflow group's Global Controller runs. `canyonos deploy` and `canyonos clean`
reuse it.
"""

import os
import shutil

from canyonos import deployment, selection, ui
from canyonos.api import (
    UNKNOWN_WORKFLOW_GROUP,
    ApiError,
    delete_workflow_group,
    list_workflow_groups,
    workflow_group_status,
)
from canyonos.auth import hash_api_key, machine_api_key
from canyonos.docker_cmd import (
    DOCKER_CLEANUP_TIMEOUT,
    DOCKER_QUICK_TIMEOUT,
    cleanup_docker,
    run_docker,
)
from canyonos.dashboard_stack import (
    COMPOSE_PROJECT,
    leave_deployment_network,
    running_web_port,
    stop_dashboard,
    teardown_dashboard,
)
from canyonos.init import docker_env, load_state
from canyonos.serve import ensure_api
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


def ensure_api_for_stop():
    """Bring up the CanyonOS API, which stops a workflow group's Global Controller, with
    it checking this machine's API key; raise RuntimeError when it can't start."""
    ensure_api(hash_api_key(machine_api_key()))


def _status(state):
    """The CanyonOS API's status of the workflow group `state` records, or None when the
    API knows no such workflow group. Raises ApiError when the API can't say."""
    return workflow_group_status(state)


def _delete(state):
    """Have the CanyonOS API stop the workflow group `state` records and forget it;
    returns why it couldn't, or None. A workflow group the API doesn't know is already
    stopped as far as it goes."""
    try:
        delete_workflow_group(state)
    except ApiError as e:
        if e.code != UNKNOWN_WORKFLOW_GROUP:
            return f"Stopping the workflow group failed: {e}"
    return None


def stop_deployment(state, name=None):
    """Stop workflow group `name`, by default this folder's: have the CanyonOS API stop
    its Global Controller, then remove the container, its network and volume; when its
    deploy was not running, remove every container, volume and network labelled with
    the workflow group. The dashboard is left. Returns what it couldn't remove; the
    state file stays whenever something is left, so the stop can be retried. When the
    API can't be asked, nothing is removed.

    It decides nothing: whether a workflow group may be stopped is `stop_if_safe`'s call.
    Teardown reports rather than raises, since it is also a step of `canyonos deploy`.
    """
    name = name or deployment.deployment_name()
    # The exact engine this deploy's container was created on, not whatever
    # context is active now -- they can differ (see docker_env).
    env = docker_env(state)
    with ui.status(f"Tearing down {name}..."):
        try:
            status = _status(state)
        except ApiError as e:
            failures = [str(e)]
        else:
            # Always first: it stops a running deploy, and forgets the workflow group
            # either way.
            failure = _delete(state)
            failures = [failure] if failure else []
            if status is not None and status["running"]:
                failures += _tear_down(name, state, env)
            else:
                failures += _remove_deployment_resources(
                    [name], env
                ) or _remove_state_files([name])
    if failures:
        ui.fail(f"Teardown of {name} incomplete:\n- " + "\n- ".join(failures))
        ui.hint(
            f"State was preserved at {deployment.state_path(name)}, so "
            f"`canyonos stop {name}` can be retried."
        )
    else:
        ui.ok(f"{name} torn down")
    return failures


def _safe_to_stop(state, status):
    """True when the CanyonOS API's `status` says the workflow group's deploy runs, so
    its stop removes what it started, or its Global Controller container `state`
    records is still there and never started, or ended and cleaned up after itself;
    False when the API knows no such workflow group, the container is gone, or it
    exited without finishing, so what it started may still be there."""
    if status is None:
        return False
    if status["running"]:
        return True
    exists = _container_state(state["container_id"], docker_env(state))[0]
    return exists and status.get("error_code") != "controller_exited"


def stop_if_safe(state, name=None):
    """`stop_deployment` for workflow group `name`, by default this folder's, unless its
    Global Controller is gone or exited without finishing: why is unknown, so what it
    started is removed only when the user names the workflow group. Returns what it
    couldn't stop."""
    name = name or deployment.deployment_name()
    try:
        status = _status(state)
    except ApiError as e:
        ui.fail(str(e))
        return [str(e)]
    if _safe_to_stop(state, status):
        return stop_deployment(state, name)
    failure = (
        f"Could not stop `{name}`: its Global Controller is not running, so removing "
        f"its replicas and Redis is not safe. Run `canyonos stop {name}` to force it."
    )
    ui.fail(failure)
    return [failure]


def stopper(choice):
    """How to stop the workflow groups of `choice`: `stop_deployment` when the user named or
    ticked them, else `stop_if_safe`."""
    return stop_deployment if choice.confirmed else stop_if_safe


def _tear_down(name, state, env):
    """Remove the Global Controller container of workflow group `name`, which the
    CanyonOS API has stopped, the workflow group's network and volume, and the state
    files; returns what it couldn't."""
    container_id = state["container_id"]
    failures = []
    # The API stopped the deploy first, so the replica and Redis containers it
    # spawned via docker-outside-of-docker are torn down too. Removing the GC
    # container itself doesn't touch them -- they're sibling containers on the host,
    # not nested inside it.
    failure = cleanup_docker(
        ["docker", "stop", container_id],
        action=f"Stopping Global Controller {container_id[:12]}",
        missing_text="No such container",
        timeout=DOCKER_CLEANUP_TIMEOUT,
        env=env,
    )
    if failure:
        failures.append(failure)

    failure = cleanup_docker(
        ["docker", "rm", container_id],
        action=f"Removing Global Controller {container_id[:12]}",
        missing_text="No such container",
        timeout=DOCKER_CLEANUP_TIMEOUT,
        env=env,
    )
    if failure:
        failures.append(failure)

    network = deployment.deployment_group(name)
    leave_deployment_network(network)
    failure = cleanup_docker(
        ["docker", "network", "rm", network],
        action=f"Removing Docker network {network}",
        missing_text="not found",
        timeout=DOCKER_CLEANUP_TIMEOUT,
        env=env,
    )
    if failure:
        failures.append(failure)

    # Remove the workspace volume only after the container is gone (docker
    # refuses to remove a volume still in use). A missing volume is already
    # the desired end state; every other failure remains retryable.
    volume = deployment.workspace_volume(name)
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
        path = deployment.state_path(name)
        try:
            os.remove(path)
        except FileNotFoundError:
            pass
        except OSError as e:
            failures.append(f"Removing CanyonOS state at {path} failed: {e}")
    return failures


def _list_docker(argv, action, env=None):
    """The lines a Docker listing prints, or the failure as a string."""
    try:
        result = run_docker(argv, timeout=DOCKER_QUICK_TIMEOUT, action=action, env=env)
    except RuntimeError as e:
        return str(e)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()
        return f"{action} failed: {detail or f'exit code {result.returncode}'}"
    return result.stdout.splitlines()


def _recorded_ids(deployments):
    """The workflow group of each of `deployments` this machine records, by its
    `workflow_group_id`."""
    recorded = {}
    for name in deployments:
        state_path = os.path.join(deployment.deployments_dir(), name, "state.json")
        try:
            state = load_state(state_path)
        except (FileNotFoundError, RuntimeError):
            continue
        if state.get("workflow_group_id"):
            recorded[state["workflow_group_id"]] = name
    return recorded


def _stop_listed_deployments(deployments):
    """Have the CanyonOS API stop every workflow group it holds or finds a Global
    Controller of, as `stop` does, so what each started elsewhere (EC2 machines) goes
    too. Returns what it couldn't stop, and those of `deployments` it couldn't stop,
    which are left as they are: all of them when the API could not list them."""
    try:
        listed = list_workflow_groups()
    except ApiError as e:
        return [f"Listing the workflow groups failed: {e}"], set(deployments)
    recorded = _recorded_ids(deployments)
    failures, kept = [], set()
    for held in listed:
        failure = _delete(held)
        if failure:
            name = recorded.get(held["workflow_group_id"])
            failures.append(f"{name or held['name'] or 'A workflow group'}: {failure}")
            kept.add(name)
    return failures, kept


# Containers first: Docker refuses to remove a volume or network still in use.
_DEPLOYMENT_RESOURCES = (
    # -v takes each container's anonymous volumes (Redis's /data) with it.
    (["docker", "ps", "-a"], "ID", ["docker", "rm", "-f", "-v"], "containers"),
    (["docker", "volume", "ls"], "Name", ["docker", "volume", "rm"], "volumes"),
    (["docker", "network", "ls"], "Name", ["docker", "network", "rm"], "networks"),
)
# The network every workflow group shared before each got its own; it carries no label.
LEGACY_NETWORK = "canyonos-local"


def _remove_deployment_resources(deployments, env=None):
    """Remove every container, volume and network labelled with one of `deployments`,
    whether or not its folder still exists, on the Docker engine `env` points at;
    returns what it couldn't. Matched against CanyonOS's records, since another
    Compose stack can also be named `canyonos-...`."""
    groups = {f"canyonos-{name}" for name in deployments}
    failures = []
    for listing, field, remove, kind in _DEPLOYMENT_RESOURCES:
        listed = _list_docker(
            [
                *listing,
                "--filter",
                f"label={deployment.PROJECT_LABEL}",
                "--format",
                f'{{{{.{field}}}}} {{{{.Label "{deployment.PROJECT_LABEL}"}}}}',
            ],
            f"Listing CanyonOS {kind}",
            env,
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
            # The dashboard's api and db keep their place on each workflow group's
            # network, and a stopped api would not start again on one that is gone.
            for network in names:
                leave_deployment_network(network)
        if names:
            failure = cleanup_docker(
                [*remove, *names],
                action=f"Removing CanyonOS {kind}",
                missing_text="not found" if kind == "networks" else "No such",
                timeout=DOCKER_CLEANUP_TIMEOUT,
                env=env,
            )
            if failure:
                failures.append(failure)
    return failures


def _remove_state_files(deployments):
    """Delete the state files of each of `deployments` whose Global Controller is gone
    from the Docker engine it was deployed on; returns what it couldn't. One still there
    runs on an engine this run didn't reach, and its state file is what can still stop
    it."""
    failures = []
    for name in deployments:
        state_path = os.path.join(deployment.deployments_dir(), name, "state.json")
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
        try:
            os.remove(state_path)
        except FileNotFoundError:
            pass
        except OSError as e:
            failures.append(f"Removing CanyonOS state at {state_path} failed: {e}")
    return failures


def _unlabelled_leftovers():
    """Names of containers an older CLI started before workflow groups were labelled. They
    are only reported: a name alone can't tell them from someone else's."""
    listed = _list_docker(
        [
            "docker",
            "ps",
            "-a",
            "--format",
            f'{{{{.Names}}}}\t{{{{.Label "{deployment.PROJECT_LABEL}"}}}}\t'
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


def agent_images(name):
    """The `docker images` reference every agent image of workflow group `name` matches."""
    return f"canyonos-{name}-*"


def remove_images(references):
    """Remove the images matching `references`; returns what it couldn't. Removed by
    name and tag, so another name for the same image (a registry copy) keeps it."""
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
    """Delete `~/.canyonos`: every workflow group's records, the dashboard's, and the usage
    settings; returns what it couldn't."""
    home = os.path.dirname(deployment.deployments_dir())
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
            "~/.canyonos, with this machine's API key, so it asks first. Add --yes to "
            "run it without a terminal."
        )
        return False
    ui.say(
        "This removes every CanyonOS workflow group, the dashboard and its data, "
        "CanyonOS's images and ~/.canyonos, which holds every workflow group's records, "
        "your usage settings and this machine's API key."
    )
    answer = select_menu(
        [(True, "Yes, remove everything"), (False, "No, keep it")],
        title="Remove CanyonOS from this machine?",
    )
    return answer is True


def _stop_stack(remove_everything):
    """Stop the dashboard's stack, keeping its history, or with `remove_everything`
    remove it and its data; returns what it couldn't."""
    if remove_everything:
        return [] if teardown_dashboard() else ["Removing the dashboard stack failed"]
    return [] if stop_dashboard() else ["Stopping the dashboard failed"]


def stop_all(remove_everything=False):
    """`canyonos stop --all`: tear down every CanyonOS workflow group on this machine, from
    any folder, and stop the dashboard, keeping its history. With `remove_everything`,
    for `canyonos clean --all`, also remove the dashboard and its data, CanyonOS's
    images and `~/.canyonos`, leaving only the CLI to uninstall. The CanyonOS API stops
    each Global Controller, so the stack goes last, and stays when one could not be
    stopped. Returns True when everything was removed."""
    try:
        deployments = os.listdir(deployment.deployments_dir())
    except FileNotFoundError:
        deployments = []
    ui.json_result["workflow_groups"] = deployments
    ensure_api_for_stop()
    with ui.status("Tearing down every CanyonOS workflow group..."):
        failures, kept = _stop_listed_deployments(deployments)
        # Whatever the API could not stop keeps the API, and so the stack, it needs.
        stack_needed = bool(failures)
        deployments = [name for name in deployments if name not in kept]
        failures += _remove_deployment_resources(deployments)
        failure = cleanup_docker(
            ["docker", "network", "rm", LEGACY_NETWORK],
            action=f"Removing Docker network {LEGACY_NETWORK}",
            missing_text="not found",
            timeout=DOCKER_CLEANUP_TIMEOUT,
        )
        if failure:
            failures.append(failure)
        if not failures:
            failures += _remove_state_files(deployments)
        # Last, since the API stopped the workflow groups; one it couldn't stop still
        # needs it.
        if not stack_needed:
            failures += _stop_stack(remove_everything)
        if remove_everything and not failures:
            failures += remove_images(
                [*_OWN_IMAGES, *(agent_images(name) for name in deployments)]
            )
            listed = _list_docker(["docker", "volume", "ls", "-q"], "Listing volumes")
            if isinstance(listed, str):
                failures.append(listed)
            else:
                # Every volume CanyonOS makes is named canyonos-...
                for volume in [name for name in listed if name.startswith("canyonos")]:
                    failure = cleanup_docker(
                        ["docker", "volume", "rm", volume],
                        action=f"Removing Docker volume {volume}",
                        missing_text="No such volume",
                        timeout=DOCKER_CLEANUP_TIMEOUT,
                    )
                    if failure:
                        failures.append(failure)
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
        ui.ok("Every CanyonOS workflow group is torn down and the dashboard stopped")
    leftovers = _unlabelled_leftovers()
    if leftovers:
        ui.hint(
            "These containers look like an older CanyonOS's but carry no workflow group "
            "label, so they were left in place. If they are, remove them with "
            f"`docker rm -f {' '.join(leftovers)}`."
        )
    return not failures


def stop_unused_dashboard(deployments):
    """Stop the dashboard unless a Global Controller still runs on the Docker engine of
    one of `deployments`, which were just stopped; False when stopping it failed."""
    with ui.status("Stopping the dashboard..."):
        dashboard_kept = any(
            deployment.other_global_controllers_running(None, docker_env(p.state))
            for p in deployments
        )
        if not dashboard_kept and not stop_dashboard():
            ui.fail("Stopping the dashboard failed")
            return False
    if dashboard_kept and running_web_port() is not None:
        ui.hint(
            "The dashboard was left running because another CanyonOS workflow group is "
            "still deployed."
        )
    return True


def stop_deployments(choice):
    """Stop each workflow group of `choice` as `stopper` says, then stop the dashboard
    if no other workflow group runs. Returns True when nothing of them is left running."""
    stop = stopper(choice)
    stopped = [not stop(p.state, p.name) for p in choice.deployments]
    return stop_unused_dashboard(choice.deployments) and all(stopped)


def run_stop(all_deployments=False, refs=()):
    """Run `canyonos stop`: `stop_deployments` on the workflow groups `refs` name or
    `selection.choose` picks, or `stop_all` with `all_deployments`. Returns True when
    each was found and nothing of it is left running."""
    if all_deployments:
        return stop_all()
    choice = selection.choose("stop", refs, selection.recorded_deployments())
    ui.json_result["workflow_groups"] = [p.name for p in choice.deployments]
    if not choice.deployments:
        if choice.ok:
            ui.warn("No workflow group is running.")
        return choice.ok
    ensure_api_for_stop()
    return stop_deployments(choice) and choice.ok
