# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
The deployment a CanyonOS command acts on: the one started from the folder it runs
from.

Every Docker resource a deployment starts (its Global Controller, Redis, agent
replicas and images, its workspace volume) carries the deployment in its name and
in the `com.docker.compose.project` label, so two deployments run side by side on
one machine and Docker Desktop shows each as its own group. The CLI's own
records for a deployment live under `~/.canyonos/deployments/<deployment>/`.

Where the deployment runs is its `target`: Docker on this machine, or the Kubernetes
cluster `kubectl` points at. Its `deployment.yaml` says it once, so every command
in its folder goes there; `--target` on one command overrides it.

The container and image names mirror
`canyonos_core/controller/utils/container_names.py`. The CLI and the
canyonos_core image ship separately and cannot share an import, so keep the
two in step.
"""

import os
import re
import secrets
from pathlib import Path

import yaml

from canyonos.constants import (
    deployment_config_path,
    project_config_path,
    project_folder,
    read_config,
)
from canyonos.docker_cmd import DOCKER_QUICK_TIMEOUT, run_docker
from canyonos.os_support import make_private_dir, write_private_file

DOCKER_PROJECT_ENV = "CANYONOS_DOCKER_PROJECT"
PROJECT_LABEL = "com.docker.compose.project"
ROLE_LABEL = "canyonos.role"
GC_ROLE = "global-controller"
NETWORK_ROLE = "deployment-network"

# Keep in sync with canyonos_core/schema/manifest.py.
TARGETS = ("docker", "kubernetes")
DEFAULT_TARGET = TARGETS[0]

MAX_NAME_LENGTH = 24
DEFAULT_NAME = "default"
# A deployment named `dashboard` would share the group `canyonos-dashboard` with the
# dashboard stack, and taking that stack down would take the deployment with it.
RESERVED_NAMES = {"dashboard": "dashboard-deployment"}
# What the Global Controller writes beside the projects in the deployment's workspace,
# so no project can take their names.
BUILD_FOLDERS = ("grpc_stubs", "docker_container")


def folder_name():
    """Return the name of the folder the command runs from, as typed; the Global
    Controller records it as the deployment's name."""
    return os.path.basename(os.getcwd())


def _docker_safe(name):
    """Turn a folder name into one Docker accepts in container names, labels and
    network aliases: lowercase letters, digits, `_` and `-`, at most 24 characters,
    `default` when nothing usable is left."""
    name = re.sub(r"[^a-z0-9_-]", "-", name.lower())
    name = re.sub(r"-+", "-", name).strip("-")
    return name[:MAX_NAME_LENGTH].rstrip("-") or DEFAULT_NAME


def normalise(name):
    """Turn a folder name into a deployment name: Docker-safe, and never one the
    dashboard stack's group takes."""
    deployment = _docker_safe(name)
    return RESERVED_NAMES.get(deployment, deployment)


def deployment_name():
    """Return the deployment for the folder the command runs from: the folder's name and
    the start of its `deployment_id`, so two folders with the same name never share one."""
    name = normalise(folder_name())
    deployment_id = read_config(deployment_config_path()).get("deployment_id")
    return f"{name}-{deployment_id[:8]}" if deployment_id else name


def projects(folders):
    """Map each project of the deployment, named after its folder as Docker accepts
    names, to its folder. Raises when the deployment's own folder is a project, so
    that projects can join and leave it, when a folder holds no
    `config/workflow_config.yaml`, or when two folders would be the same project."""
    if os.path.isfile(project_config_path(project_folder())):
        raise RuntimeError(
            "This folder is a project. Give the deployment a folder of its own, which "
            "holds its deployment.yaml: `cd .. && canyonos deploy <project> --folder <deployment>`."
        )
    projects = {}
    for folder in folders:
        name = _docker_safe(os.path.basename(os.path.abspath(folder)))
        if name in BUILD_FOLDERS:
            raise RuntimeError(
                f"A project can't be named {name!r}: the deployment builds its images "
                "in a folder of that name. Rename the folder."
            )
        if not os.path.isfile(project_config_path(project_folder(folder))):
            raise RuntimeError(
                f"No {project_config_path(project_folder(folder))}: is {folder} a "
                "project folder?"
            )
        if name in projects:
            raise RuntimeError(
                f"{folder} and {projects[name]} would both be the project {name!r}; "
                "rename one of the folders."
            )
        projects[name] = folder
    return projects


def configured_target(config_path=None):
    """The `target` in this deployment's config, lowercased, or docker without one (or
    without a config). Any other value, or a config that is not valid YAML, is
    refused here, before a command acts on it: a Kubernetes deployment must not pass
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


def resolve_target(flag):
    """The target a command runs on: its `--target` when given, else the deployment's."""
    return flag or configured_target()


def kubernetes_command(command):
    """How to run `canyonos <command>` on Kubernetes from this folder: as is once the
    deployment's target is kubernetes, else with `--target kubernetes`."""
    flag = "" if configured_target() == "kubernetes" else " --target kubernetes"
    return f"canyonos {command}{flag}"


def deployment_group(name=None):
    """Return the Docker group every container of deployment `name`, by default this
    folder's, is labelled with."""
    return f"canyonos-{name or deployment_name()}"


def deployment_label_args():
    """Return the `docker run` flags that put a container in this deployment's group."""
    return ["--label", f"{PROJECT_LABEL}={deployment_group()}"]


def gc_role_label_args():
    """Return the `docker run` flags that mark a container as a Global Controller, so
    `canyonos stop` can tell whether another deployment still needs the dashboard."""
    return ["--label", f"{ROLE_LABEL}={GC_ROLE}"]


def network_label_args():
    """Return the `docker network create` flags that put this deployment's network in
    its group and mark it as a deployment's network, which the dashboard joins."""
    return [*deployment_label_args(), "--label", f"{ROLE_LABEL}={NETWORK_ROLE}"]


def redis_container_name():
    """Return the name of this deployment's Redis container, as the Global Controller
    names it."""
    return f"canyonos-{deployment_name()}-redis-localhost"


def gc_container_name():
    """Return the name of this deployment's Global Controller container."""
    return f"canyonos-{deployment_name()}-global-controller"


def workspace_volume(name=None):
    """Return the Docker volume the files of deployment `name`, by default this
    folder's, are copied into for a deploy."""
    return f"canyonos-{name or deployment_name()}-workspace"


def docker_name(agent):
    """Return an agent name as Docker names it: lowercase, and the `.` of
    `<project>.<agent>` written `--`."""
    return agent.lower().replace(".", "--")


def image_name(agent):
    """Return the image the Global Controller builds for one of this deployment's
    agents, named `<project>.<agent>`."""
    return f"canyonos-{deployment_name()}-{docker_name(agent)}"


def deployments_dir():
    """Return the folder under `~/.canyonos` that holds every deployment's records."""
    return os.path.join(os.path.expanduser("~/.canyonos"), "deployments")


def state_dir(name=None):
    """Return the folder under `~/.canyonos` that holds the records of deployment
    `name`, by default this folder's."""
    return os.path.join(deployments_dir(), name or deployment_name())


def state_path(name=None):
    """Return the file that records the Global Controller container and port of
    deployment `name`, by default this folder's."""
    return os.path.join(state_dir(name), "state.json")


def redis_password_path(name=None):
    """Return the file that holds the Redis password of deployment `name`, by default
    this folder's."""
    return os.path.join(state_dir(name), "redis_password")


def redis_password(name=None):
    """Return the Redis password of deployment `name`, by default this folder's, made on
    its first use and kept after."""
    path = redis_password_path(name)
    if not os.path.isfile(path):
        make_private_dir(Path(state_dir(name)))
        write_private_file(path, secrets.token_hex(32))
    with open(path, encoding="utf-8") as f:
        return f.read()


def sync_manifest_path():
    """Return the file that lists the files the last `canyonos sync` copied."""
    return os.path.join(state_dir(), "sync-manifest.json")


def other_global_controllers_running(own_container_id, env=None):
    """Return True when a Global Controller other than `own_container_id` (any, when
    None) is running on this Docker engine, from any deployment. Also True when Docker
    can't answer, so the shared dashboard is never taken down from under another
    deployment."""
    try:
        result = run_docker(
            [
                "docker",
                "ps",
                "-q",
                "--no-trunc",
                "--filter",
                f"label={ROLE_LABEL}={GC_ROLE}",
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
