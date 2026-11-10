# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
The project a CanyonOS command acts on: the folder it runs from.

Every Docker resource a project starts (its Global Controller, Redis, agent
replicas and images, its workspace volume) carries the project in its name and
in the `com.docker.compose.project` label, so two projects run side by side on
one machine and Docker Desktop shows each as its own group. The CLI's own
records for a project live under `~/.canyonos/projects/<project>/`.

Where the project runs is its `target`: Docker on this machine, or the Kubernetes
cluster `kubectl` points at. Its `global_controller.yaml` says it once, so every
command in its folder goes there; `--target` on one command overrides it.

The container and image names mirror
`canyonos_core/controller/utils/container_names.py`. The CLI and the
canyonos_core image ship separately and cannot share an import, so keep the
two in step.
"""

import os
import re

import yaml

from canyonos.constants import default_config_path, read_config
from canyonos.docker_cmd import DOCKER_QUICK_TIMEOUT, run_docker

DOCKER_PROJECT_ENV = "CANYONOS_DOCKER_PROJECT"
PROJECT_LABEL = "com.docker.compose.project"
ROLE_LABEL = "canyonos.role"
GC_ROLE = "global-controller"
NETWORK_ROLE = "project-network"

# Keep in sync with canyonos_core/schema/manifest.py.
TARGETS = ("docker", "kubernetes")
DEFAULT_TARGET = TARGETS[0]

MAX_PROJECT_LENGTH = 24
DEFAULT_PROJECT = "default"
# A project named `dashboard` would share the group `canyonos-dashboard` with the
# dashboard stack, and taking that stack down would take the project with it.
RESERVED_PROJECTS = {"dashboard": "dashboard-project"}


def folder_name():
    """Return the name of the folder the command runs from, as typed; the Global
    Controller records it as the deploy's project name."""
    return os.path.basename(os.getcwd())


def normalise(name):
    """Turn a folder name into a project name Docker accepts in container names,
    labels and network aliases: lowercase letters, digits, `_` and `-`, at most
    24 characters, `default` when nothing usable is left."""
    project = re.sub(r"[^a-z0-9_-]", "-", name.lower())
    project = re.sub(r"-+", "-", project).strip("-")
    project = project[:MAX_PROJECT_LENGTH].rstrip("-")
    project = project or DEFAULT_PROJECT
    return RESERVED_PROJECTS.get(project, project)


def project_name():
    """Return the project for the folder the command runs from: the folder's name and
    the start of its `project_id`, so two folders with the same name never share one."""
    name = normalise(folder_name())
    project_id = read_config(default_config_path()).get("project_id")
    return f"{name}-{project_id[:8]}" if project_id else name


def configured_target(config_path=None):
    """The `target` in this project's config, lowercased, or docker without one (or
    without a config). Any other value, or a config that is not valid YAML, is
    refused here, before a command acts on it: a Kubernetes project must not pass
    for a Docker one."""
    config_path = config_path or default_config_path()
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
    """The target a command runs on: its `--target` when given, else the project's."""
    return flag or configured_target()


def kubernetes_command(command):
    """How to run `canyonos <command>` on Kubernetes from this folder: as is once the
    project's target is kubernetes, else with `--target kubernetes`."""
    flag = "" if configured_target() == "kubernetes" else " --target kubernetes"
    return f"canyonos {command}{flag}"


def project_group():
    """Return the Docker group every container of this project is labelled with."""
    return f"canyonos-{project_name()}"


def project_label_args():
    """Return the `docker run` flags that put a container in this project's group."""
    return ["--label", f"{PROJECT_LABEL}={project_group()}"]


def gc_role_label_args():
    """Return the `docker run` flags that mark a container as a Global Controller, so
    `canyonos stop` can tell whether another project still needs the dashboard."""
    return ["--label", f"{ROLE_LABEL}={GC_ROLE}"]


def network_label_args():
    """Return the `docker network create` flags that put this project's network in its
    group and mark it as a project's network, which the dashboard joins."""
    return [*project_label_args(), "--label", f"{ROLE_LABEL}={NETWORK_ROLE}"]


def redis_container_name():
    """Return the name of this project's Redis container, as the Global Controller
    names it."""
    return f"canyonos-{project_name()}-redis-localhost"


def gc_container_name():
    """Return the name of this project's Global Controller container."""
    return f"canyonos-{project_name()}-global-controller"


def workspace_volume():
    """Return the Docker volume this project's files are copied into for a deploy."""
    return f"canyonos-{project_name()}-workspace"


def image_name(agent):
    """Return the image the Global Controller builds for one of this project's
    agents."""
    return f"canyonos-{project_name()}-{agent.lower()}"


def replica_name_pattern(agent):
    """Return the regex every replica container of one of this project's agents fully
    matches by name: `canyonos-<project>-<agent>-` and 8 hex characters."""
    return re.escape(f"canyonos-{project_name()}-{agent.lower()}-") + "[0-9a-f]{8}"


def projects_dir():
    """Return the folder under `~/.canyonos` that holds every project's records."""
    return os.path.join(os.path.expanduser("~/.canyonos"), "projects")


def state_dir():
    """Return the folder under `~/.canyonos` that holds this project's records."""
    return os.path.join(projects_dir(), project_name())


def state_path():
    """Return the file that records this project's Global Controller container and
    port."""
    return os.path.join(state_dir(), "state.json")


def sync_manifest_path():
    """Return the file that lists the project files the last `canyonos sync` copied."""
    return os.path.join(state_dir(), "sync-manifest.json")


def other_global_controllers_running(own_container_id, env=None):
    """Return True when a Global Controller other than `own_container_id` is running
    on this Docker engine, from any project. Also True when Docker can't answer,
    so the shared dashboard is never taken down from under another project."""
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
