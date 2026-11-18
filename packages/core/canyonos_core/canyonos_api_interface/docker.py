# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""The Global Controller server's Docker side: start, stop and reload the deploy
process in this container, and read the deploy's status, agent logs and health from
it and its Redis."""

import os
import secrets
import signal
import subprocess
import sys
import threading
import urllib.error
import urllib.request
from functools import partial

import redis
import yaml
from flask import jsonify

from canyonos_core.controller.controller_context import (
    DEFAULT_REDIS_PORT,
    _redis_connect_host,
    list_replicas,
    run_on_machine,
)
from canyonos_core.controller.utils.config_env import expand_env_value, read_dotenv
from canyonos_core.controller.utils.config_specs import read_config_specs
from canyonos_core.controller.utils.redis_client import PASSWORD_ENV, RedisClient
from canyonos_core.deploy_progress import DeployProgress
from canyonos_core.endpoint import (
    ENDPOINT_AGENT_NAME,
    ENDPOINT_PORT,
    read_endpoint_record,
)
from canyonos_core.reconciler import replicas, state
from canyonos_core.reconciler.parallel import run_in_parallel
from canyonos_core.schema import DEPLOYMENT_CONFIG, SchemaError, check_deployment

# Longer than the Global Controller's own teardown wait, so a stop that drains finishes.
CLEAN_TIMEOUT_SECONDS = 255
RELOAD_TIMEOUT_SECONDS = 60
STARTUP_TIMEOUT_SECONDS = 30 * 60
# A failed deploy usually stops itself; waited out so its log and root cause are complete.
SELF_STOP_SECONDS = 30

_workspace = None


def running_deploy(progress):
    """Return `progress`, a deploy's progress or None, while its deploy process is
    alive, else None."""
    if progress is None or progress.process.poll() is not None:
        return None
    return progress


def _read_deploy_output(progress):
    """Copy each line the deploy process prints to this server's stdout and into
    `progress`, then settle its phase once the process exits. Runs on its own thread,
    started with the deploy."""
    for line in progress.process.stdout:
        print(line, end="", flush=True)
        progress.add_line(line)
    progress.finish(progress.process.wait())


def _stop_deploy_unless_up(progress, lock):
    """Fail the deploy when it is not up within 30 minutes, and stop it, holding `lock`,
    once it has failed and has not stopped itself. Runs on its own thread, started with
    the deploy."""
    with progress.changed:
        if not progress.changed.wait_for(
            lambda: progress.phase != "starting" or progress.finished,
            STARTUP_TIMEOUT_SECONDS,
        ):
            progress.phase, progress.error_code = "failed", "deploy_timeout"
            progress.error = (
                f"The deploy was not up within {STARTUP_TIMEOUT_SECONDS // 60} minutes."
            )
            progress.changed.notify_all()
        elif progress.phase != "failed" or progress.changed.wait_for(
            lambda: progress.finished, SELF_STOP_SECONDS
        ):
            return
    with lock:
        if running_deploy(progress) is progress:
            _stop_deploy(progress)


def _stop_deploy(progress):
    """SIGTERM the deploy process and return its exit code once it exits; raises
    `subprocess.TimeoutExpired` when it is still running after the clean timeout."""
    progress.stopping = True
    progress.process.send_signal(signal.SIGTERM)
    return progress.process.wait(timeout=CLEAN_TIMEOUT_SECONDS)


def start(workspace, name, deployed, lock):
    """Build and deploy the deployment uploaded to `workspace` as `name` in a background
    process, recording `deployed` as the fingerprints it runs; return its progress.
    `lock` is held while a failed deploy is stopped."""
    global _workspace
    _workspace = os.path.realpath(workspace)
    # Build then launch the Global Controller, with cwd as the workspace so build
    # outputs land beside the projects.
    process = subprocess.Popen(
        [sys.executable, "-m", "canyonos_core.cli", "deploy"],
        cwd=workspace,
        # Unbuffered, so each line reaches the reader as it is printed.
        env={
            **os.environ,
            "CANYONOS_PROJECT_NAME": name,
            "PYTHONUNBUFFERED": "1",
        },
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        encoding="utf-8",
        errors="replace",
    )
    progress = DeployProgress(process, deployed)
    threading.Thread(target=_read_deploy_output, args=(progress,), daemon=True).start()
    threading.Thread(
        target=_stop_deploy_unless_up, args=(progress, lock), daemon=True
    ).start()
    return progress


def stop(progress):
    """Stop the running deploy and wait for it to exit; return the error and its code
    when it did not stop in time or exited with an error."""
    try:
        return_code = _stop_deploy(progress)
    except subprocess.TimeoutExpired:
        return {
            "error": (
                f"Global Controller did not stop within {CLEAN_TIMEOUT_SECONDS} seconds"
            ),
            "code": "stop_timeout",
        }
    if return_code:
        return {
            "error": f"Global Controller stopped with exit code {return_code}",
            "code": "stop_failed",
        }
    return None


def reload(progress, config_fingerprint):
    """Have the running deploy reload the config uploaded to `/workspace`, without
    restarting the agents that stay, and wait for the outcome; return the error and its
    code when the manifest is invalid, the reload failed or no answer came."""
    _, violations = check_deployment(_workspace)
    if violations:
        return {"error": str(SchemaError(violations)), "code": "config_invalid"}
    progress.reload_answered = False
    progress.process.send_signal(signal.SIGHUP)
    with progress.changed:
        progress.changed.wait_for(
            lambda: progress.reload_answered or progress.finished,
            RELOAD_TIMEOUT_SECONDS,
        )
    if not progress.reload_answered:
        if progress.finished:
            return {
                "error": "The deploy stopped while reloading.",
                "code": "reload_failed",
            }
        return {
            "error": "The Global Controller did not finish reloading within "
            f"{RELOAD_TIMEOUT_SECONDS} seconds.",
            "code": "reload_timeout",
        }
    if not progress.reload["ok"]:
        return {"error": progress.reload["error"], "code": "reload_failed"}
    progress.deployed = {**progress.deployed, "config": config_fingerprint}
    return None


def _redis_password():
    """The password this deployment's Redis container was started with, so a new
    controller still opens it, else a new random one when there is no such container."""
    inspect = subprocess.run(
        [
            "docker",
            "inspect",
            "-f",
            "{{range .Config.Env}}{{println .}}{{end}}",
            os.environ["CANYONOS_REDIS_HOST"],
        ],
        capture_output=True,
        text=True,
    )
    for line in inspect.stdout.splitlines():
        key, _, value = line.partition("=")
        if key == PASSWORD_ENV:
            return value
    return secrets.token_hex(32)


# Set before the server's apply loop starts, so every deploy process inherits it.
os.environ[PASSWORD_ENV] = _redis_password()


def status(progress, report):
    """Fill `report` with the phase, progress and verdict of the deploy `progress`
    reports, if any, and while it runs, its endpoint, agents and machine errors read
    from Redis; a part that could not be read is named under `errors`."""
    if progress is not None:
        report.update(progress.report())
    if report["running"]:
        try:
            redis_client = _deploy_redis(_deploy_config(_workspace))
            report["endpoint"] = read_endpoint_record(redis_client)
            report["agents"] = _read_agents(redis_client)
            report["machine_errors"] = redis_client.hgetall(state.MACHINE_ERRORS_KEY)
        except (OSError, yaml.YAMLError, redis.RedisError) as e:
            report["errors"].append(f"Could not read the deploy's state in Redis: {e}")


def health(progress):
    """Answer `GET .../health`: check the running deploy's Global Controller, Redis,
    each agent's replica count and its endpoint, each with how to fix it when it
    fails; 409 if no deploy is running."""
    progress, workspace = running_deploy(progress), _workspace
    if progress is None:
        return jsonify({"error": "not running", "code": "not_running"}), 409
    checks = [
        _check(
            "Global Controller",
            lambda: (True, f"deploy process {progress.process.pid}"),
            None,
        ),
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
    return jsonify({"ok": all(check["ok"] for check in checks), "checks": checks}), 200


def _check(name, probe, fix):
    """Run one health probe, which returns (ok, detail); one that raises fails with
    its error as the detail. Returns the check as `GET /deployment/health` reports
    it."""
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
    """Send a request to the endpoint replica over the deployment's network; any HTTP
    answer counts (the 401 of an API key check, or the 404 of the probe's unknown
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


def _deploy_config(workspace):
    """Return the running deploy's `deployment.yaml` with its `${VAR}`s expanded from
    the `.env` beside it and this process's environment, without importing either.
    The projects' files aren't read: a `canyonos sync` copies them in before the
    reload checks them, so one can be broken while the deploy runs."""
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
    failed, if it did. Used by `GET /deployment` and its health check."""
    launch_errors = redis_client.hgetall(state.LAUNCH_ERRORS_KEY)
    return {
        agent_spec["name"]: {
            "desired_replicas": state.get_desired(redis_client, agent_spec["name"]),
            "running_replicas": len(list_replicas(redis_client, agent_spec["name"])),
            "launch_error": launch_errors.get(agent_spec["name"]),
        }
        for agent_spec in read_config_specs(redis_client) or []
    }


def agent_logs(progress, name, tail):
    """Answer `GET .../logs/agents/<name>`: the last `tail` lines of each running
    replica of agent `name`, or of the replica whose ID is `name`; 409 if no deploy
    runs, 404 naming the agents when `name` is neither, 503 when Redis can't be read."""
    workspace = _workspace
    if workspace is None or not running_deploy(progress):
        return jsonify({"error": "not running", "code": "not_running"}), 409
    try:
        config = _deploy_config(workspace)
        redis_client = _deploy_redis(config)
        names = [spec["name"] for spec in read_config_specs(redis_client) or []]
        matching = [
            replica
            for replica in list_replicas(redis_client)
            if name in (replica["agent_name"], replica["replica_id"])
        ]
    except (OSError, yaml.YAMLError, redis.RedisError) as e:
        return jsonify(
            {
                "error": f"Could not read the replicas: {e}",
                "code": "replicas_unreadable",
            }
        ), 503
    if not matching and name not in names:
        return jsonify(
            {
                "error": f"No agent or replica is named {name}; the agents are {', '.join(names)}",
                "code": "unknown_agent",
            }
        ), 404
    run_cmd = partial(run_on_machine, config)
    jobs = {
        replica["replica_id"]: partial(replicas.log_tail, run_cmd, replica, tail)
        for replica in matching
    }
    logs = {
        replica_id: [f"Could not read the log: {error}"] if error else lines
        for replica_id, lines, error in run_in_parallel(jobs)
    }
    return jsonify({"logs": logs}), 200
