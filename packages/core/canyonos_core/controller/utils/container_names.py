# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Docker names, labels, the controller port and image for everything CanyonOS launches.

Every place that creates, bootstraps, or cleans up a container, image, or volume
derives the name from here, so replica launch and the controller's
stale-container removal cannot drift apart. The `canyonos` CLI keeps a copy of
the same scheme in `canyonos/project.py`, since it cannot import this package.

The project comes from `CANYONOS_DOCKER_PROJECT`, which the CLI sets on the
Global Controller container. It is read on every call, never at import, so a
process that sets it late still names things right. Without it, every name and
label falls back to the plain `canyonos-...` form used before projects existed.
"""

import os

# The gRPC port a local controller listens on inside every agent and endpoint container.
CONTAINER_PORT = 50051

# Set by the CLI to the image the GC itself runs; the endpoint and the metrics
# collectors run it too. No default: guessing one means silently running a stale
# image that need not hold the code this GC was built from.
CONTROLLER_IMAGE = os.environ.get("CANYONOS_CONTROLLER_IMAGE")

DOCKER_PROJECT_ENV = "CANYONOS_DOCKER_PROJECT"
PROJECT_LABEL = "com.docker.compose.project"


class ForeignContainerError(RuntimeError):
    """A container with one of this project's names is running but is not this
    project's to replace or remove; nothing was launched in its place."""


def _prefix():
    project = os.environ.get(DOCKER_PROJECT_ENV, "")
    return f"canyonos-{project}" if project else "canyonos"


def project_group():
    """Return the Docker Desktop group this project's containers show under,
    `canyonos-<project>`, or `canyonos` when no project is set."""
    return _prefix()


def project_label_args():
    """Return the `docker run` flags that put a container in this project's group,
    so two projects on one machine show and clean up apart."""
    return ["--label", f"{PROJECT_LABEL}={project_group()}"]


def container_name(agent_name, replica_index):
    """Return the Docker container name for one agent replica,
    `canyonos-<project>-<agent>-<replica>`."""
    return f"{_prefix()}-{agent_name.lower()}-{replica_index}"


def redis_container_name(host):
    """The single source of truth for this name -- every caller (the controller
    that creates it, and every launch that points an agent at it) must agree,
    or agents connect to a Redis container that doesn't exist under the name
    they were given."""
    return f"{_prefix()}-redis-{host.replace('.', '-')}"


def metrics_container_name(host):
    """Return the name of the machine-metrics collector on one host; the controller
    reuses a running one and clears a stopped one under this name."""
    return f"{_prefix()}-metrics-{host.replace('.', '-')}"


def image_name(agent_name):
    """Return the image tag a deploy builds for an agent and its replicas run, so a
    project's rebuild never replaces another project's image."""
    return f"{_prefix()}-{agent_name.lower()}"


def data_volume_name(agent_name):
    """Return the Docker volume a database agent keeps its data in, which outlives
    its containers across redeploys."""
    return f"{_prefix()}-{agent_name.lower()}-data"
