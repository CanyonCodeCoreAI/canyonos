# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Start, check and remove the Docker container one replica runs in. Every machine runs
containers the same way: this one directly, any other over SSH."""

import logging
import os
import re
import socket
import time
from contextlib import contextmanager
from functools import partial

from canyonos_core.controller.controller_context import _is_local_host
from canyonos_core.controller.utils.container_log import dump_container_log
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
from canyonos_core.controller.utils.port_utils import is_port_conflict
from canyonos_core.controller.utils.redis_utils import _wait_for_redis
from canyonos_core.endpoint import ENDPOINT_PORT
from canyonos_core.reconciler.providers.shared_utils.docker_host import (
    container_log_tail,
    container_running,
)
from canyonos_core.reconciler.providers.shared_utils.llm_gateway_env import (
    llm_gateway_docker_env_args,
)
from canyonos_core.reconciler.providers.shared_utils.resource_limits import (
    resource_limit_args,
)

logger = logging.getLogger(__name__)

MAX_PORT_ATTEMPTS = 50
NETWORK = "canyonos-local"
HOST_GATEWAY = "host.docker.internal"
# The host port in Docker's "Bind for 0.0.0.0:8080 failed" and "listen tcp
# 0.0.0.0:8080: bind" messages.
_CLASHED_PORT = re.compile(r"(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-fA-F:]*\]):(\d+)")


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


def _refuse_other_projects_container(controller, container, host, user):
    """Raise instead of replacing a running container that has this replica's name
    but belongs to another project. Project `my` with agent `app-worker` and project
    `my-app` with agent `worker` both name a replica `canyonos-my-app-worker-0`; a
    container with no project label predates projects and is replaced as before."""
    labels = controller._run_cmd(
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


def launch(controller, machine, agent_spec, replica_index, host_port, replica_id):
    """Start a replica's container on its machine, publishing it on `host_port` or the
    next free port (replacing a leftover one with the same name), and return the
    replica's record. The image must already be on the machine. Starts another machine's
    Redis first if it isn't running. Used by the provisioner for every launch."""
    agent_name = agent_spec["name"]
    agent_type = agent_spec.get("type", "agent")
    image = image_name(agent_name)
    host = machine["private_host"]
    user = machine.get("user")
    container = container_name(agent_name, replica_index)
    is_local = _is_local_host(host)
    # A remote machine has no canyonos-local network, so reach its Redis via the host.
    redis_host = redis_container_name(host) if is_local else HOST_GATEWAY

    inspect = controller._run_cmd(
        ["docker", "inspect", "-f", "{{.State.Running}}", container], host, user
    )
    if inspect.returncode == 0 and inspect.stdout.strip() == "true":
        _refuse_other_projects_container(controller, container, host, user)
        logger.warning(
            "No Redis record for %s but a container with that name is already running; "
            "treating it as orphaned and recreating.",
            container,
        )
        controller._run_cmd(["docker", "rm", "-f", container], host, user)

    container_port = CONTAINER_PORT
    if agent_type == "database":
        host_port, container_port = int(agent_spec.get("db_port", 5432)), 5432
        if is_local and _port_bound(host_port):
            raise RuntimeError(
                f"db_port {host_port} is already in use and can't be reassigned "
                "automatically -- free it or change `db_port` in the database's config."
            )

    redis_port = controller.redis_ports.get(host, 6379)
    machine_redis = controller.machine_redis_for_replica(
        {"private_host": host, "redis_port": redis_port}
    )
    # Started with its machine; this restarts one that died since.
    start_redis(controller, host, user)

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
        _clear_stale_status(machine_redis, host, address, container)

        cmd = [
            "docker",
            "run",
            "-d",
            *project_label_args(),
            *(["--network", NETWORK] if is_local else ["--restart", "unless-stopped"]),
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
            f"CANYONOS_POLL_INTERVAL={controller.config.get('poll_interval', 5)}",
            # Route the agent's LLM SDK calls through the in-container gateway for telemetry.
            *llm_gateway_docker_env_args(),
            "-e",
            f"CANYONOS_LOGS_ENABLED={str(bool(controller.config.get('logs', True))).lower()}",
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

        with _image_args(controller, agent_spec, image, host, user) as image_args:
            cmd.extend(image_args)
            result = controller._run_cmd(cmd, host, user)

        if result.returncode == 0:
            break
        if is_port_conflict(result.stderr):
            # A failed port bind leaves a `Created` container under this name; remove it
            # so the retry doesn't hit a name conflict instead of the port conflict.
            controller._run_cmd(["docker", "rm", "-f", container], host, user)
            clashed = _clashed_port(result.stderr)
            if clashed not in (None, host_port):
                raise RuntimeError(
                    f"Port {clashed} is already in use on {host}. Free it or change "
                    "the setting that publishes it in global_controller.yaml (the "
                    "endpoint's `api_port`)."
                )
            host_port += 1
            continue
        if "contains whitespaces" in result.stderr:
            raise RuntimeError(
                f"{result.stderr.strip()} Docker reads .env lines only as "
                "KEY=value, with no `export` and no spaces around `=`."
            )
        raise RuntimeError(f"Failed to launch {container}: {result.stderr}")
    else:
        raise RuntimeError(
            f"Failed to launch {container}: no free port found after "
            f"{MAX_PORT_ATTEMPTS} attempts"
        )

    machine_redis.set(f"controller:{address}:replica_id", replica_id)

    replica = {
        "agent_name": agent_name,
        "provider": agent_spec["provider"],
        "replica_index": str(replica_index),
        "private_host": host,
        "public_host": machine["public_host"],
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
    if machine.get("container_timeout"):
        try:
            _wait_until_reachable(address, int(machine["container_timeout"]))
        except TimeoutError:
            # Show the log now: removing a failed launch can take its machine and log with it.
            dump_container_log(
                replica, "unreachable", partial(log_tail, controller._run_cmd)
            )
            raise
    logger.info("Replica ready: %s -> %s", container, replica["published_address"])
    return replica


def start_redis(controller, host, user):
    """Start a machine's Redis container, unless it is already running, and wait until it
    answers. This machine's Redis is the Global Controller's, so only another machine gets
    one here."""
    if _is_local_host(host) or container_running(
        controller, redis_container_name(host), host, user
    ):
        return
    redis_port = controller.redis_ports.get(host, 6379)
    machine_redis = controller.machine_redis_for_replica(
        {"private_host": host, "redis_port": redis_port}
    )
    result = controller._run_cmd(
        [
            "docker",
            "run",
            "-d",
            *project_label_args(),
            "--name",
            redis_container_name(host),
            *resource_limit_args(),
            "-p",
            f"{redis_port}:{redis_port}",
            "redis:alpine",
            "redis-server",
            "--port",
            str(redis_port),
        ],
        host,
        user,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"Failed to start Redis on {host}: {(result.stderr or result.stdout or '').strip()}"
        )
    _wait_for_redis(machine_redis, host, redis_port)


def _wait_until_reachable(address, timeout):
    """Wait until the launched container accepts TCP connections."""
    host, port = address.split(":")
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection((host, int(port)), timeout=2):
                return True
        except OSError:
            time.sleep(2)
    raise TimeoutError(f"Replica address never became reachable at {address}.")


def _callback_host(agent_spec):
    """Return the address agents on other machines call the endpoint's controller
    back on, this machine's private IP, or None for any other agent or when the
    CLI found no private IP."""
    if agent_spec.get("type") != "endpoint":
        return None
    return os.environ.get("CANYONOS_PRIVATE_IP") or None


@contextmanager
def _image_args(controller, agent_spec, image, host, user):
    """Yield the `docker run` args that end the command and pick what runs.

    The endpoint runs the controller image as `python -m canyonos_core.endpoint`,
    publishing its HTTP port on `api_port` and serving one agent method. Any other
    agent runs its own image with the project's `.env`; explicit -e flags before
    it still win, so a stray CANYONOS_* line in someone's .env cannot break agent
    wiring.
    """
    if agent_spec.get("type") == "endpoint":
        if not CONTROLLER_IMAGE:
            raise RuntimeError(
                "CANYONOS_CONTROLLER_IMAGE is unset, so the endpoint has no image to "
                "run. Redeploy with `canyonos deploy`."
            )
        served = controller.agent_specs_by_name[agent_spec["agent"]]
        function = next(
            function
            for function in served["functions"]
            if function["name"] == agent_spec["method"]
        )
        arguments = [argument["name"] for argument in function.get("arguments") or []]
        yield [
            "-p",
            f"{agent_spec['api_port']}:{ENDPOINT_PORT}",
            "-e",
            f"CANYONOS_ENDPOINT_AGENT={agent_spec['agent']}",
            "-e",
            f"CANYONOS_ENDPOINT_METHOD={agent_spec['method']}",
            "-e",
            f"CANYONOS_ENDPOINT_ARGUMENTS={','.join(arguments)}",
            "--entrypoint",
            "python",
            CONTROLLER_IMAGE,
            "-m",
            "canyonos_core.endpoint",
        ]
        return
    with env_file_args(controller, host, user, _is_local_host(host)) as args:
        yield [*args, image]


def _clashed_port(stderr):
    """Return the host port a failed `docker run` could not publish, or None when
    Docker's message does not name one."""
    match = _CLASHED_PORT.search(stderr or "")
    return int(match.group(1)) if match else None


def _clear_stale_status(machine_redis, host, address, container):
    """Delete the status and drain keys the container about to start will own.

    The keys have no TTL and the address is derived from the container name, so
    whatever the last container at this address said -- in this run or one
    that crashed -- is still there, and the readiness wait would read it as the
    new container's. Fails closed: a launch that cannot clear them must not
    proceed, or a stale "healthy" passes for a container that never came up, and
    a stale drain flag has the new container turn requests away.
    """
    try:
        machine_redis.delete(
            f"controller:{address}:status", f"controller:{address}:draining"
        )
    except Exception as e:
        raise RuntimeError(
            f"Cannot launch {container}: could not clear the stale status "
            f"keys at {address} on {host}: {e}"
        ) from e


def remove_container(controller, record):
    """Remove a replica's container from its machine; a container that is already gone
    is not an error. Its machine is left running."""
    container = record.get("container_name")
    if not container:
        return

    result = controller._run_cmd(
        ["docker", "rm", "-f", container], record["private_host"], record.get("user")
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()
        if "no such container" not in detail.casefold():
            raise RuntimeError(
                f"Failed to remove container {container}: "
                f"{detail or f'exit code {result.returncode}'}"
            )


def is_running(controller, record):
    """True if the replica's container is running on its machine; an unreachable machine
    counts as not running. Used before reusing a replica that already has a record."""
    return container_running(
        controller, record["container_name"], record["private_host"], record.get("user")
    )


def log_tail(run_cmd, record, lines):
    """Return the last `lines` lines of the replica container's output, read with
    `run_cmd` on its machine. Raises RuntimeError with the reason if they can't be read."""
    return container_log_tail(
        run_cmd,
        record.get("container_name"),
        record["private_host"],
        record.get("user"),
        lines,
    )
