# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Docker names, labels, the controller port and image for everything CanyonOS launches.

Every place that creates, bootstraps, or cleans up a container, image, or volume
derives the name from here, so replica launch and the controller's
stale-container removal cannot drift apart. The `canyonos` CLI keeps a copy of
the same scheme in `canyonos/deployment.py`, since it cannot import this package.

The workflow group comes from `CANYONOS_DOCKER_PROJECT`, which the CLI sets on the
Global Controller container. It is read on every call, never at import, so a
process that sets it late still names things right. Without it, every name and
label falls back to the plain `canyonos-...` form used before workflow groups existed.
"""

import os

# The gRPC port a local controller listens on inside every agent and endpoint container.
CONTAINER_PORT = 50051

# Set by the CLI to the image the GC itself runs; the endpoint and the metrics
# collectors run it too. No default: guessing one means silently running a stale
# image that need not hold the code this GC was built from.
CONTROLLER_IMAGE = os.environ.get("CANYONOS_CONTROLLER_IMAGE")
# Set by the CLI to the official release image of its version. Machines other than this
# one run their metrics collector from it: CONTROLLER_IMAGE may be a dev image built
# here, which they have no registry to pull from.
COLLECTOR_IMAGE = os.environ.get("CANYONOS_COLLECTOR_IMAGE")

DOCKER_PROJECT_ENV = "CANYONOS_DOCKER_PROJECT"
PROJECT_LABEL = "com.docker.compose.project"


class ForeignContainerError(RuntimeError):
    """A container with one of this workflow group's names is running but is not this
    workflow group's to replace or remove; nothing was launched in its place."""


def _prefix():
    workflow_group = os.environ.get(DOCKER_PROJECT_ENV, "")
    return f"canyonos-{workflow_group}" if workflow_group else "canyonos"


def docker_group():
    """Return the Docker Desktop group this workflow group's containers show under,
    `canyonos-<workflow group>`, or `canyonos` when no workflow group is set."""
    return _prefix()


def docker_group_label_args():
    """Return the `docker run` flags that put a container in this workflow group's
    Docker group, so two workflow groups on one machine show and clean up apart."""
    return ["--label", f"{PROJECT_LABEL}={docker_group()}"]


def docker_name(name):
    """Return an agent name or replica ID as Docker names it: lowercase, and the `.`
    of `<workflow>.<agent>` written `--`, since a container name is also a hostname.
    The manifest refuses two agents of a workflow that this names the same."""
    return name.lower().replace(".", "--")


def container_name(replica_id):
    """Return the Docker container name for one agent replica,
    `canyonos-<workflow group>-<replica ID>` (e.g.
    `canyonos-prod-portfolio--intentagent-1a2b3c4d`)."""
    return f"{_prefix()}-{docker_name(replica_id)}"


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
    workflow group's rebuild never replaces another workflow group's image."""
    return f"{_prefix()}-{docker_name(agent_name)}"


def workspace_volume_name():
    """Return the Docker volume the workflow group's files are synced into, as the CLI names it."""
    return f"{_prefix()}-workspace"


def data_volume_name(agent_name):
    """Return the Docker volume a database agent keeps its data in, which outlives
    its containers across redeploys."""
    return f"{_prefix()}-{docker_name(agent_name)}-data"
