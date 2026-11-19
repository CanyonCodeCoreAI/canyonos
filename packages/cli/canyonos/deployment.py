# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
The workflow group a CanyonOS command acts on: the one started from the folder it runs
from.

Every Docker resource a workflow group starts (its Global Controller, Redis, agent
replicas and images, its workspace volume) carries the workflow group in its name and
in the `com.docker.compose.project` label, so two workflow groups run side by side on
one machine and Docker Desktop shows each as its own group. The CLI's own
records for a workflow group live under `~/.canyonos/deployments/<workflow group>/`.

Where the workflow group runs is its `target`: Docker on this machine, or the Kubernetes
cluster `kubectl` points at. Its `workflow_group.yaml` says it once, so every command
in its folder goes there.

The container and image names mirror
`canyonos_core/controller/utils/container_names.py`. The CLI and the
canyonos_core image ship separately and cannot share an import, so keep the
two in step.
"""

import os
import re
import uuid

import yaml

from canyonos.constants import (
    deployment_config_path,
    load_yaml,
    read_config,
    round_trip_yaml,
    workflow_config_path,
    workflow_folder,
    write_config,
)
from canyonos.docker_cmd import DOCKER_QUICK_TIMEOUT, run_docker

DOCKER_PROJECT_ENV = "CANYONOS_DOCKER_PROJECT"
PROJECT_LABEL = "com.docker.compose.project"
ROLE_LABEL = "canyonos.role"
GC_ROLE = "global-controller"
# The CanyonOS API finds a workflow group's Global Controller container by it.
WORKFLOW_GROUP_LABEL = "canyonos.workflow_group_id"
NETWORK_ROLE = "deployment-network"

# Keep in sync with canyonos_core/schema/manifest.py.
TARGETS = ("docker", "kubernetes")
DEFAULT_TARGET = TARGETS[0]

MAX_NAME_LENGTH = 24
DEFAULT_NAME = "default"
# A workflow group named `dashboard` would share the group `canyonos-dashboard` with the
# dashboard stack, and taking that stack down would take the workflow group with it.
RESERVED_NAMES = {"dashboard": "dashboard-deployment"}
# A workflow's name is its folder's, cut to this, then `-` and the start of its
# workflow_id, so it is at most MAX_NAME_LENGTH long, as Docker names need.
WORKFLOW_NAME_LENGTH = MAX_NAME_LENGTH - 9


def folder_name():
    """Return the name of the folder the command runs from, as typed."""
    return os.path.basename(os.getcwd())


def _docker_safe(name):
    """Turn a folder name into one Docker accepts in container names, labels and
    network aliases: lowercase letters, digits, `_` and `-`, at most 24 characters,
    `default` when nothing usable is left."""
    name = re.sub(r"[^a-z0-9_-]", "-", name.lower())
    name = re.sub(r"-+", "-", name).strip("-")
    return name[:MAX_NAME_LENGTH].rstrip("-") or DEFAULT_NAME


def normalise(name):
    """Turn a folder name into a workflow group name: Docker-safe, and never one the
    dashboard stack's group takes."""
    deployment = _docker_safe(name)
    return RESERVED_NAMES.get(deployment, deployment)


def deployment_name():
    """Return the workflow group for the folder the command runs from: the folder's name and
    the start of its `workflow_group_id`, so two folders with the same name never share one."""
    name = normalise(folder_name())
    deployment_id = read_config(deployment_config_path()).get("workflow_group_id")
    return f"{name}-{deployment_id[:8]}" if deployment_id else name


def workflow_ids(folders, new=True):
    """Map each folder to its workflow_id: the one the workflow group's `workflows:` keeps
    for its path, else a new random one when `new` (the deploy saves it, see
    save_workflows), so redeploying a folder keeps its id and a copy of it gets its
    own. Without `new`, a folder the workflow group has none for raises."""
    workflows = read_config(deployment_config_path()).get("workflows") or {}
    saved = {
        os.path.abspath(entry["path"]): entry["workflow_id"]
        for entry in workflows.values()
    }
    taken = {workflow_id[:8] for workflow_id in saved.values()}
    ids = {}
    for folder in folders:
        path = os.path.abspath(folder)
        if path in saved:
            ids[path] = saved[path]
        elif not new:
            raise RuntimeError(
                f"{folder} isn't in this workflow group yet: deploy it with "
                "`canyonos deploy` first."
            )
        else:
            # Names carry the id's start, so no two may share one.
            while (workflow_id := str(uuid.uuid4()))[:8] in taken:
                pass
            taken.add(workflow_id[:8])
            ids[path] = workflow_id
    return ids


def workflow_folders(folders, ids):
    """Map each workflow of the workflow group to its folder, named after the folder as
    Docker accepts names and the start of its workflow_id in `ids` (see workflow_ids),
    so two folders of the same name are two workflows. Raises when the workflow group's own
    folder is a workflow, so that workflows can join and leave it, when a folder holds
    no `config/workflow_config.yaml`, or when a folder is given twice."""
    if os.path.isfile(workflow_config_path(workflow_folder())):
        raise RuntimeError(
            "This folder is a workflow. Give the workflow group a folder of its own, which "
            "holds its workflow_group.yaml: `cd .. && canyonos deploy <workflow> --workflow-group <group>`."
        )
    named = {}
    for folder in folders:
        if not os.path.isfile(workflow_config_path(workflow_folder(folder))):
            raise RuntimeError(
                f"No {workflow_config_path(workflow_folder(folder))}: is {folder} a "
                "workflow folder?"
            )
        path = os.path.abspath(folder)
        if path in map(os.path.abspath, named.values()):
            raise RuntimeError(f"{folder} is given twice.")
        base = _docker_safe(os.path.basename(path))[:WORKFLOW_NAME_LENGTH].rstrip("-")
        named[f"{base}-{ids[path][:8]}"] = folder
    return named


def save_workflows(config_path, folders, ids):
    """Keep each workflow's workflow_id in the workflow group's `workflows:`, by its name,
    with its folder's path from the workflow group's own folder."""
    yaml_rt = round_trip_yaml()
    data = load_yaml(config_path, yaml_rt.load)
    if not isinstance(data, dict):
        return
    workflows = data.setdefault("workflows", {})
    for name, folder in folders.items():
        path = os.path.abspath(folder)
        workflows[name] = {
            "path": os.path.relpath(path).replace(os.sep, "/"),
            "workflow_id": ids[path],
        }
    write_config(config_path, data, yaml_rt)


def workflow_names_by_id():
    """Each workflow in the workflow group's `workflows:`, its name by its workflow_id:
    the workflows its Global Controller publishes to its Redis as the workflow
    group's."""
    workflows = read_config(deployment_config_path()).get("workflows") or {}
    return {entry["workflow_id"]: name for name, entry in workflows.items()}


def configured_target(config_path=None):
    """The `target` in this workflow group's config, lowercased, or docker without one (or
    without a config). Any other value, or a config that is not valid YAML, is
    refused here, before a command acts on it: a Kubernetes workflow group must not pass
    for a Docker one."""
    config_path = config_path or deployment_config_path()
    try:
        with open(config_path, encoding="utf-8") as f:
            config = yaml.safe_load(f)
    except FileNotFoundError:
        return DEFAULT_TARGET
    except (OSError, yaml.YAMLError) as error:
        raise RuntimeError(f"Could not read {config_path}: {error}") from None
    value = config.get("target") if isinstance(config, dict) else None
    if value is None:
        return DEFAULT_TARGET
    if not isinstance(value, str) or value.casefold() not in TARGETS:
        raise RuntimeError(
            f"`target: {value}` in {config_path} is not one of {', '.join(TARGETS)}"
        )
    return value.casefold()


def deployment_group(name=None):
    """Return the Docker group every container of workflow group `name`, by default this
    folder's, is labelled with."""
    return f"canyonos-{name or deployment_name()}"


def deployment_label_args():
    """Return the `docker run` flags that put a container in this workflow group's group."""
    return ["--label", f"{PROJECT_LABEL}={deployment_group()}"]


def gc_role_label_args():
    """Return the `docker create` flags that mark a container as a Global Controller,
    so `canyonos stop` can tell whether another workflow group still needs the
    dashboard."""
    return ["--label", f"{ROLE_LABEL}={GC_ROLE}"]


def workflow_group_label_args(workflow_group_id):
    """Return the `docker create` flags that name the workflow group a Global
    Controller container runs, by which the CanyonOS API finds it."""
    return ["--label", f"{WORKFLOW_GROUP_LABEL}={workflow_group_id}"]


def network_label_args():
    """Return the `docker network create` flags that put this workflow group's network in
    its group and mark it as a workflow group's network, which the dashboard joins."""
    return [*deployment_label_args(), "--label", f"{ROLE_LABEL}={NETWORK_ROLE}"]


def redis_container_name():
    """Return the name of this workflow group's Redis container, as the Global Controller
    names it."""
    return f"canyonos-{deployment_name()}-redis-localhost"


def gc_container_name():
    """Return the name of this workflow group's Global Controller container."""
    return f"canyonos-{deployment_name()}-global-controller"


def workspace_volume(name=None):
    """Return the Docker volume the files of workflow group `name`, by default this
    folder's, are copied into for a deploy."""
    return f"canyonos-{name or deployment_name()}-workspace"


def docker_name(agent):
    """Return an agent name as Docker names it: lowercase, and the `.` of
    `<workflow>.<agent>` written `--`."""
    return agent.lower().replace(".", "--")


def image_name(agent):
    """Return the image the Global Controller builds for one of this workflow group's
    agents, named `<workflow>.<agent>`."""
    return f"canyonos-{deployment_name()}-{docker_name(agent)}"


def deployments_dir():
    """Return the folder under `~/.canyonos` that holds every workflow group's records."""
    return os.path.join(os.path.expanduser("~/.canyonos"), "deployments")


def state_dir(name=None):
    """Return the folder under `~/.canyonos` that holds the records of workflow group
    `name`, by default this folder's."""
    return os.path.join(deployments_dir(), name or deployment_name())


def state_path(name=None):
    """Return the file that records the Global Controller container and the ports of
    workflow group `name`, by default this folder's."""
    return os.path.join(state_dir(name), "state.json")


def other_global_controllers_running(own_container_id, env=None):
    """Return True when a Global Controller other than `own_container_id` (any, when
    None) is running on this Docker engine, from any workflow group, or created by a
    deploy that has yet to have the CanyonOS API start it. Also True when Docker can't
    answer, so the shared dashboard is never taken down from under another workflow
    group."""
    try:
        result = run_docker(
            [
                "docker",
                "ps",
                "-a",
                "-q",
                "--no-trunc",
                "--filter",
                f"label={ROLE_LABEL}={GC_ROLE}",
                "--filter",
                "status=running",
                "--filter",
                "status=created",
            ],
            timeout=DOCKER_QUICK_TIMEOUT,
            action="Listing running Global Controllers",
            env=env,
        )
    except RuntimeError:
        return True
    if result.returncode != 0:
        return True
    return any(
        container_id != own_container_id for container_id in result.stdout.split()
    )
