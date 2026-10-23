# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
Local provider for CanyonOS.

This module is the local-provider backend for `provider: local` agents.
It keeps the existing Docker launch/teardown behavior while letting
the Provisioner stay focused on orchestration and persistence.
"""

import logging
import os
import re
import socket
from contextlib import contextmanager

from canyonos_core.controller.utils.container_names import (
    CONTAINER_PORT,
    CONTROLLER_IMAGE,
    PROJECT_LABEL,
    ForeignContainerError,
    container_name,
    data_volume_name,
    image_name,
    project_group,
    project_label_args,
    redis_container_name,
)
from canyonos_core.controller.utils.env_file import env_file_args
from canyonos_core.endpoint import ENDPOINT_PORT
from canyonos_core.reconciler.providers.shared_utils.docker_host import (
    container_log_tail,
    container_running,
)
from canyonos_core.reconciler.providers.shared_utils.image_transfer import (
    transfer_image,
)
from canyonos_core.reconciler.providers.shared_utils.llm_gateway_env import (
    llm_gateway_docker_env_args,
)
from canyonos_core.reconciler.providers.shared_utils.resource_limits import (
    resource_limit_args,
)
from canyonos_core.controller.utils.port_utils import is_port_conflict

logger = logging.getLogger(__name__)

DEFAULT_HOST = "localhost"
PROVIDER = "local"
MAX_PORT_ATTEMPTS = 50
NETWORK = "canyonos-local"
HOST_GATEWAY = "host.docker.internal"
# The host port in Docker's "Bind for 0.0.0.0:8080 failed" and "listen tcp
# 0.0.0.0:8080: bind" messages.
_CLASHED_PORT = re.compile(r"(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-fA-F:]*\]):(\d+)")
_controller = None


def _require_controller():
    if _controller is None:
        raise RuntimeError("Local provider controller is not configured.")
    return _controller


def _is_local_host(host):
    return host in {"localhost", "127.0.0.1"}


def _port_bound(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        # docker publishes ports with SO_REUSEADDR, so a lingering TIME_WAIT
        # socket doesn't stop it. Match that, or the probe reports a port as
        # taken right after a container that used it went down.
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            probe.bind(("127.0.0.1", port))
        except OSError:
            return True
    return False


def preflight():
    """Do nothing: building the images already needed Docker on this machine."""
    return None


def port_claim_host(agent_spec):
    """Return the agent's host, where each new replica is given a free port."""
    return agent_spec.get("host", DEFAULT_HOST)


def ssh_user(entry):
    """The SSH user an agent spec or replica record names, if any."""
    return entry.get("user")


def hourly_cost(agent_spec):
    """Return 0: a local replica has no hourly cost."""
    return 0


def provision_replica(agent_spec, replica_index, next_host_port, launch_id):
    """Choose where a new local replica runs and its name, without starting it."""
    host = agent_spec.get("host", DEFAULT_HOST)
    host_port = int(
        agent_spec.get("host_port", agent_spec.get("port", next_host_port(host)))
    )
    agent_name = agent_spec["name"]

    return {
        "provider": PROVIDER,
        "private_host": host,
        "public_host": host,
        "host_port": host_port,
        # A remote host has no canyonos-local network, so reach its Redis via the host.
        "redis_host": redis_container_name(host)
        if _is_local_host(host)
        else HOST_GATEWAY,
        "container_name": container_name(agent_name, replica_index),
        "user": agent_spec.get("user"),
    }


def _refuse_other_projects_container(container, host, user):
    """Raise instead of replacing a running container that has this replica's name
    but belongs to another project. Project `my` with agent `app-worker` and project
    `my-app` with agent `worker` both name a replica `canyonos-my-app-worker-0`; a
    container with no project label predates projects and is replaced as before."""
    labels = _require_controller()._run_cmd(
        [
            "docker",
            "inspect",
            "-f",
            f'{{{{index .Config.Labels "{PROJECT_LABEL}"}}}}',
            container,
        ],
        host,
        user,
    )
    if labels.returncode != 0:
        if "no such" in (labels.stderr or "").lower():
            return
        raise ForeignContainerError(
            f"Cannot launch {container}: a container with that name is running but "
            f"Docker would not say which project owns it: {labels.stderr.strip()}"
        )
    owner = labels.stdout.strip()
    if owner and owner != project_group():
        raise ForeignContainerError(
            f"Cannot launch {container}: a container with that name already runs in "
            f"Docker group {owner}, not {project_group()}. Rename the agent or the "
            "project folder so the names no longer collide."
        )


def bootstrap_replica(provisioned, agent_spec, replica_index, replica_id):
    """Start a local replica's Docker container (replacing a leftover one with the same
    name) and return its replica record."""
    agent_name = agent_spec["name"]
    agent_type = agent_spec.get("type", "agent")
    image = image_name(agent_name)
    host = provisioned["private_host"]
    host_port = provisioned["host_port"]
    user = provisioned.get("user")
    redis_host = provisioned["redis_host"]
    container = provisioned["container_name"]
    is_local = _is_local_host(host)

    inspect = _require_controller()._run_cmd(
        ["docker", "inspect", "-f", "{{.State.Running}}", container], host, user
    )
    if inspect.returncode == 0 and inspect.stdout.strip() == "true":
        _refuse_other_projects_container(container, host, user)
        logger.warning(
            "No Redis record for %s but a container with that name is already running; "
            "treating it as orphaned and recreating.",
            container,
        )
        _require_controller()._run_cmd(["docker", "rm", "-f", container], host, user)

    container_port = CONTAINER_PORT
    if agent_type == "database":
        host_port, container_port = int(agent_spec.get("db_port", 5432)), 5432
        if is_local and _port_bound(host_port):
            raise RuntimeError(
                f"db_port {host_port} is already in use and can't be reassigned "
                "automatically -- free it or change `db_port` in the database's config."
            )

    redis_port = _require_controller().redis_ports.get(
        host, agent_spec.get("redis_port", 6379)
    )

    if not is_local:
        transfer_image(_require_controller(), image, host, user)

    callback_host = _callback_host(agent_spec)
    for attempt in range(MAX_PORT_ATTEMPTS):
        # Other machines can't resolve container names, so they reach a replica on its
        # published port: a remote one at its host, the endpoint at the private IP.
        if is_local and not callback_host:
            agent_host, agent_port = container, container_port
        else:
            agent_host, agent_port = callback_host or host, host_port
        address = f"{agent_host}:{agent_port}"
        # Last thing before `docker run`, after any orphan under this name is gone.
        _clear_stale_status(host, address, container)

        cmd = [
            "docker",
            "run",
            "-d",
            *project_label_args(),
            *(["--network", NETWORK] if is_local else []),
            "--name",
            container,
            # Docker Desktop resolves this automatically; native Linux Docker
            # (e.g. an EC2 test box) does not unless told to.
            "--add-host",
            "host.docker.internal:host-gateway",
            "-p",
            f"{host_port}:{container_port}",
            "-e",
            f"CANYONOS_AGENT_PORT={agent_port}",
            "-e",
            f"CANYONOS_AGENT_HOST={agent_host}",
            "-e",
            f"CANYONOS_REDIS_HOST={redis_host}",
            "-e",
            f"CANYONOS_REDIS_PORT={redis_port}",
            "-e",
            f"CANYONOS_POLL_INTERVAL={_require_controller().config.get('poll_interval', 5)}",
            # Route the agent's LLM SDK calls through the in-container gateway for telemetry.
            *llm_gateway_docker_env_args(),
            "-e",
            f"CANYONOS_LOGS_ENABLED={str(bool(_require_controller().config.get('logs', True))).lower()}",
        ]

        if agent_type == "database":
            volume_path = agent_spec.get("volume_path")
            if volume_path:
                cmd.extend(["-v", f"{data_volume_name(agent_name)}:{volume_path}"])
            for key, value in agent_spec.get("env", {}).items():
                cmd.extend(["-e", f"{key}={value}"])
        # A stock database image capped at the agent defaults gets OOM-killed under load.
        cmd.extend(
            resource_limit_args(
                agent_spec.get("resources"), apply_defaults=agent_type != "database"
            )
        )

        with _image_args(agent_spec, image, host, user) as image_args:
            cmd.extend(image_args)
            result = _require_controller()._run_cmd(cmd, host, user)

        if result.returncode == 0:
            break
        if is_port_conflict(result.stderr):
            # A failed port bind leaves a `Created` container under this name; remove it
            # so the retry doesn't hit a name conflict instead of the port conflict.
            _require_controller()._run_cmd(
                ["docker", "rm", "-f", container], host, user
            )
            clashed = _clashed_port(result.stderr)
            if clashed not in (None, host_port):
                raise RuntimeError(
                    f"Port {clashed} is already in use on {host}. Free it or change "
                    "the setting that publishes it in global_controller.yaml (the "
                    "endpoint's `api_port`)."
                )
            host_port += 1
            continue
        raise RuntimeError(f"Failed to launch {container}: {result.stderr}")
    else:
        raise RuntimeError(
            f"Failed to launch {container}: no free port found after "
            f"{MAX_PORT_ATTEMPTS} attempts"
        )

    controller = _require_controller()
    machine_redis = controller.machine_redis.get(host) or controller.redis
    machine_redis.set(f"controller:{address}:replica_id", replica_id)

    replica = {
        "agent_name": agent_name,
        "provider": PROVIDER,
        "replica_index": str(replica_index),
        "private_host": host,
        "public_host": host,
        "host_port": str(host_port),
        "container_port": str(container_port),
        "published_address": f"{host}:{host_port}",
        "address": address,
        "redis_host": redis_host,
        "redis_port": str(redis_port),
        "container_name": container,
    }
    if user:
        replica["user"] = user
    logger.info("Replica ready: %s -> %s", container, replica["published_address"])
    return replica


def _callback_host(agent_spec):
    """Return the address agents on other machines call the endpoint's controller
    back on, this machine's private IP, or None for any other agent or when the
    CLI found no private IP."""
    if agent_spec.get("type") != "endpoint":
        return None
    return os.environ.get("CANYONOS_PRIVATE_IP") or None


@contextmanager
def _image_args(agent_spec, image, host, user):
    """Yield the `docker run` args that end the command and pick what runs.

    The endpoint runs the controller image as `python -m canyonos_core.endpoint`,
    publishing its HTTP port on `api_port` and serving one agent method. Any other
    agent runs its own image with the user's `env_file`; explicit -e flags before
    it still win, so a stray CANYONOS_* line in someone's .env cannot break agent
    wiring.
    """
    if agent_spec.get("type") == "endpoint":
        if not CONTROLLER_IMAGE:
            raise RuntimeError(
                "CANYONOS_CONTROLLER_IMAGE is unset, so the endpoint has no image to "
                "run. Redeploy with `canyonos deploy`."
            )
        yield [
            "-p",
            f"{agent_spec['api_port']}:{ENDPOINT_PORT}",
            "-e",
            f"CANYONOS_ENDPOINT_AGENT={agent_spec['agent']}",
            "-e",
            f"CANYONOS_ENDPOINT_METHOD={agent_spec['method']}",
            "--entrypoint",
            "python",
            CONTROLLER_IMAGE,
            "-m",
            "canyonos_core.endpoint",
        ]
        return
    with env_file_args(_require_controller(), host, user, _is_local_host(host)) as args:
        yield [*args, image]


def _clashed_port(stderr):
    """Return the host port a failed `docker run` could not publish, or None when
    Docker's message does not name one."""
    match = _CLASHED_PORT.search(stderr or "")
    return int(match.group(1)) if match else None


def _clear_stale_status(host, address, container):
    """Delete the status and drain keys the container about to start will own.

    The keys have no TTL and the address is derived from the container name, so
    whatever the last container at this address said -- in this run or one
    that crashed -- is still there, and the readiness wait would read it as the
    new container's. Fails closed: a launch that cannot clear them must not
    proceed, or a stale "healthy" passes for a container that never came up, and
    a stale drain flag has the new container turn requests away.
    """
    controller = _require_controller()
    machine_redis = controller.machine_redis.get(host) or controller.redis
    try:
        machine_redis.delete(
            f"controller:{address}:status", f"controller:{address}:draining"
        )
    except Exception as e:
        raise RuntimeError(
            f"Cannot launch {container}: could not clear the stale status "
            f"keys at {address} on {host}: {e}"
        ) from e


def terminate_replica(replica):
    """Remove a local replica's Docker container; a container that is already gone is
    not an error."""
    container = replica.get("container_name")
    if not container:
        return

    result = _require_controller()._run_cmd(
        ["docker", "rm", "-f", container],
        replica.get("private_host", DEFAULT_HOST),
        replica.get("user"),
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()
        if "no such container" not in detail.casefold():
            raise RuntimeError(
                f"Failed to remove container {container}: "
                f"{detail or f'exit code {result.returncode}'}"
            )


def is_running(replica):
    """True if the replica's container, named by its container name, is running on its
    host; an unreachable host counts as not running."""
    return container_running(
        _require_controller(),
        replica["container_name"],
        replica["private_host"],
        ssh_user(replica),
    )


def log_tail(replica, lines):
    """Return the last `lines` lines of the replica container's output. Raises
    RuntimeError with the reason if they can't be read."""
    return container_log_tail(
        _require_controller(),
        replica.get("container_name"),
        replica["private_host"],
        ssh_user(replica),
        lines,
    )
