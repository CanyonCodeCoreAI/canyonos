# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
The project a CanyonOS command acts on: the folder it runs from.

Every Docker resource a project starts (its Global Controller, Redis, agent
replicas and images, its workspace volume) carries the project in its name and
in the `com.docker.compose.project` label, so two projects run side by side on
one machine and Docker Desktop shows each as its own group. The CLI's own
records for a project live under `~/.canyonos/projects/<project>/`.

The container and image names mirror
`canyonos_core/controller/utils/container_names.py`. The CLI and the
canyonos_core image ship separately and cannot share an import, so keep the
two in step.
"""

import os
import re

from canyonos.docker_cmd import DOCKER_QUICK_TIMEOUT, run_docker

DOCKER_PROJECT_ENV = "CANYONOS_DOCKER_PROJECT"
PROJECT_LABEL = "com.docker.compose.project"
ROLE_LABEL = "canyonos.role"
GC_ROLE = "global-controller"

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
    """Return the project for the folder the command runs from."""
    return normalise(folder_name())


def project_group():
    """Return the Docker group every container of this project is labelled with."""
    return f"canyonos-{project_name()}"


def project_label_args():
    """Return the `docker run` flags that put a container in this project's group."""
    return ["--label", f"{PROJECT_LABEL}={project_group()}"]


def gc_role_label_args():
    """Return the `docker run` flags that mark a container as a Global Controller, so
    `canyonos stop` and `canyonos quit` can tell whether another project is running."""
    return ["--label", f"{ROLE_LABEL}={GC_ROLE}"]


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


def state_dir():
    """Return the folder under `~/.canyonos` that holds this project's records."""
    return os.path.join(os.path.expanduser("~/.canyonos"), "projects", project_name())


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
