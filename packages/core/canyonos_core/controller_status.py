# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""What the CanyonOS API reads from a running Docker workflow group, each run as a
`canyonos_core.cli` command inside its Global Controller's container against the
workspace at `/workspace`: the config check before a reload, health checks and replica
logs. Imports the controller modules, which read `CANYONOS_REDIS_PORT` on import, so
`canyonos_core.cli` imports it only inside these commands."""

import os
import re
import urllib.error
import urllib.request
from functools import partial

import redis
import yaml

from canyonos_core.controller.controller_context import (
    DEFAULT_REDIS_PORT,
    _redis_connect_host,
    list_replicas,
    run_on_machine,
)
from canyonos_core.controller.utils.config_env import expand_env_value, read_dotenv
from canyonos_core.controller.utils.config_specs import read_config_specs
from canyonos_core.controller.utils.redis_client import RedisClient
from canyonos_core.endpoint import ENDPOINT_AGENT_NAME, ENDPOINT_PORT
from canyonos_core.reconciler import replicas, state
from canyonos_core.reconciler.parallel import run_in_parallel
from canyonos_core.schema import DEPLOYMENT_CONFIG, SchemaError, check_deployment
from canyonos_core.workspace_jobs import CommandError

_READ_ERRORS = (OSError, yaml.YAMLError, redis.RedisError)
# argparse already exits 2 for a malformed command line.
UNKNOWN_AGENT_EXIT_CODE = 3


def check(workspace):
    """Check the workflow group in `workspace` before the running deploy reloads it;
    raise CommandError naming every problem when its config is invalid."""
    _, violations = check_deployment(workspace)
    if violations:
        raise CommandError(str(SchemaError(violations)))
    return {"ok": True}


def health(workspace):
    """Check the running deploy's Redis, each agent's replica count and its endpoint,
    each with how to fix it when it fails. The CanyonOS API adds the Global Controller's
    own check from its container."""
    return {
        "checks": [
            _check(
                "Redis",
                partial(_ping_redis, workspace),
                "Redis isn't answering -- redeploy, or check `docker ps`",
            ),
            _check(
                "Workflow agents",
                partial(_agents_at_desired, workspace),
                "run `canyonos logs <agent>` to see why, or `canyonos status` for its "
                "launch error",
            ),
            _check(
                "Endpoint",
                partial(_probe_endpoint, workspace),
                "the endpoint isn't answering -- run `canyonos deploy` again, or check "
                "`canyonos logs`",
            ),
        ]
    }


def _check(name, probe, fix):
    """Run one health probe, which returns (ok, detail); one that raises fails with its
    error as the detail. Returns the check as `canyonos doctor` shows it."""
    try:
        ok, detail = probe()
    except Exception as e:
        ok, detail = False, str(e)
    return {"name": name, "ok": ok, "detail": detail, "fix": None if ok else fix}


def _ping_redis(workspace):
    """PING the running deploy's Redis; return (True, its address)."""
    client = _deploy_redis(_deploy_config(workspace)).client
    client.ping()
    address = client.connection_pool.connection_kwargs
    return True, f"{address['host']}:{address['port']}"


def _agents_at_desired(workspace):
    """Return whether every agent runs at least its desired replicas, and the agents
    short of them."""
    agents = _read_agents(_deploy_redis(_deploy_config(workspace)))
    short = [
        f"{name}: {agent['running_replicas']} of {agent['desired_replicas']} "
        "replicas running"
        for name, agent in agents.items()
        if agent["running_replicas"] < agent["desired_replicas"]
    ]
    return not short, "; ".join(short) or f"{len(agents)} agent(s) running"


def _probe_endpoint(workspace):
    """Send a request to the endpoint replica over the workflow group's network; any
    HTTP answer counts (the 401 of an API key check, or the 404 of the probe's unknown
    request id) except the 503 it gives while waiting for its API key hash. Return
    whether one came and the address."""
    redis_client = _deploy_redis(_deploy_config(workspace))
    endpoints = list_replicas(redis_client, ENDPOINT_AGENT_NAME)
    if not endpoints:
        return False, "No endpoint replica is running."
    address = f"{endpoints[0]['container_name']}:{ENDPOINT_PORT}"
    try:
        urllib.request.urlopen(
            f"http://{address}/status/canyonos-health-probe", timeout=2
        )
    except urllib.error.HTTPError as e:
        return e.code != 503, address
    return True, address


def agent_logs(workspace, name, tail):
    """Return the last `tail` lines (a number or `all`) of each running replica of agent
    `name`, or of the one replica whose ID is `name`, read on its machine in parallel; a
    replica whose log can't be read gets the reason as its only line. Raise CommandError
    naming the agents, exit code 3, when `name` is neither, and exit code 1 when `tail`
    is malformed or Redis can't be read."""
    # It ends up in a shell command on a remote machine.
    if tail != "all" and not re.fullmatch(r"[0-9]+", tail):
        raise CommandError("tail must be a number or `all`")
    try:
        config = _deploy_config(workspace)
        redis_client = _deploy_redis(config)
        names = [spec["name"] for spec in read_config_specs(redis_client) or []]
        matching = [
            replica
            for replica in list_replicas(redis_client)
            if name in (replica["agent_name"], replica["replica_id"])
        ]
    except _READ_ERRORS as e:
        raise CommandError(f"Could not read the replicas: {e}") from None
    if not matching and name not in names:
        raise CommandError(
            f"No agent or replica is named {name}; the agents are {', '.join(names)}",
            exit_code=UNKNOWN_AGENT_EXIT_CODE,
        )
    run_cmd = partial(run_on_machine, config)
    jobs = {
        replica["replica_id"]: partial(replicas.log_tail, run_cmd, replica, tail)
        for replica in matching
    }
    logs = {
        replica_id: [f"Could not read the log: {error}"] if error else lines
        for replica_id, lines, error in run_in_parallel(jobs)
    }
    return {"logs": logs}


def _deploy_config(workspace):
    """Return the running deploy's `workflow_group.yaml` with its `${VAR}`s expanded
    from the `.env` beside it and this process's environment, without importing either.
    The workflows' files aren't read: an upload replaces them before the reload checks
    them, so one can be broken while the deploy runs."""
    with open(os.path.join(workspace, DEPLOYMENT_CONFIG), encoding="utf-8") as f:
        config = yaml.safe_load(f) or {}
    env = {**read_dotenv(os.path.join(workspace, ".env")), **os.environ}
    return expand_env_value(config, env)


def _deploy_redis(config):
    """Return a client for the Redis the running deploy's Global Controller publishes
    to: this machine's Redis, on its config's `redis.port`."""
    port = (config.get("redis") or {}).get("port", DEFAULT_REDIS_PORT)
    return RedisClient(host=_redis_connect_host("localhost"), port=port)


def _read_agents(redis_client):
    """Return each agent's desired and running replica counts and why its last launch
    failed, if it did."""
    launch_errors = redis_client.hgetall(state.LAUNCH_ERRORS_KEY)
    return {
        agent_spec["name"]: {
            "desired_replicas": state.get_desired(redis_client, agent_spec["name"]),
            "running_replicas": len(list_replicas(redis_client, agent_spec["name"])),
            "launch_error": launch_errors.get(agent_spec["name"]),
        }
        for agent_spec in read_config_specs(redis_client) or []
    }
