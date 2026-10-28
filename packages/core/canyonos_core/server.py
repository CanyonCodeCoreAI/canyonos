# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""HTTP server that runs in the Global Controller container; the CLI calls it to start,
stop, reload, and check a deploy."""

import logging
import os
import signal
import subprocess
import sys
import threading
from functools import partial

import redis
import yaml
from flask import Flask, jsonify, request
from werkzeug.serving import run_simple

from canyonos_core.controller.controller_context import (
    _redis_connect_host,
    list_replicas,
    replica_id_from_record,
    run_on_machine,
)
from canyonos_core.controller.utils import config_env
from canyonos_core.controller.utils.config_specs import read_config_specs
from canyonos_core.controller.utils.redis_client import RedisClient
from canyonos_core.endpoint import read_endpoint_record
from canyonos_core.reconciler import replicas, state
from canyonos_core.reconciler.parallel import run_in_parallel
from canyonos_core.schema import CONFIG_PATH, SchemaError, check_project

app = Flask("canyonos-server")

# The project files are copied here (into a named volume) by `canyonos sync` /
# `canyonos deploy`. Deploy builds and launches against this path.
WORKSPACE_DIR = "/workspace"

# Longer than the Global Controller's own teardown wait, so a stop that drains finishes.
CLEAN_TIMEOUT_SECONDS = 255

_gc_process = None
_config_path = None
_gc_lock = threading.Lock()


def _gc_running():
    return _gc_process is not None and _gc_process.poll() is None


@app.route("/deploy", methods=["POST"])
def deploy():
    """Start building and deploying the project synced into `/workspace` in a background
    process; 409 if a deploy is already running."""
    global _gc_process, _config_path

    data = request.get_json(force=True, silent=True) or {}
    # realpath, not normpath: /workspace holds a copy of the user's project, which may symlink out.
    workspace_root = os.path.realpath(WORKSPACE_DIR)
    full_path = os.path.realpath(os.path.join(workspace_root, CONFIG_PATH))
    if not full_path.startswith(workspace_root + os.sep):
        return jsonify({"error": "the config must stay inside the workspace"}), 400

    if not os.path.isfile(full_path):
        return jsonify({"error": f"config file not found: {full_path}"}), 400

    # Build then launch the Global Controller, with cwd as the workspace so build
    # outputs land beside the project files. Output streams to the container logs, which
    # `canyonos deploy` tails.
    project_name = data.get("project_name", "")
    if not isinstance(project_name, str):
        return jsonify({"error": "project_name must be a string"}), 400

    with _gc_lock:
        if _gc_running():
            return jsonify({"error": "already running"}), 409
        _config_path = full_path
        _gc_process = subprocess.Popen(
            [sys.executable, "-m", "canyonos_core.cli", "deploy"],
            cwd=WORKSPACE_DIR,
            env={**os.environ, "CANYONOS_PROJECT_NAME": project_name},
        )
        return jsonify({"status": "started", "pid": _gc_process.pid}), 200


@app.route("/clean", methods=["POST"])
def clean():
    """Stop the running deploy and wait for it to exit; 409 if none is running."""
    global _gc_process

    with _gc_lock:
        process = _gc_process
        if process is None or process.poll() is not None:
            return jsonify({"error": "not running"}), 409

        process.send_signal(signal.SIGTERM)
        try:
            process.wait(timeout=CLEAN_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            return jsonify(
                {
                    "error": (
                        "Global Controller did not stop within "
                        f"{CLEAN_TIMEOUT_SECONDS} seconds"
                    )
                }
            ), 504
        return_code = process.returncode
        _gc_process = None
        if return_code:
            return jsonify(
                {"error": f"Global Controller stopped with exit code {return_code}"}
            ), 500
        return jsonify({"status": "stopped"}), 200


@app.route("/reload", methods=["POST"])
def reload():
    """Have the running deploy reload the config synced into `/workspace`, without
    restarting the agents that stay; 409 if no deploy is running, 400 naming every
    problem when the manifest is invalid."""
    with _gc_lock:
        process = _gc_process
        if process is None or process.poll() is not None:
            return jsonify({"error": "not running"}), 409
        _, violations = check_project(_config_path)
        if violations:
            return jsonify({"error": str(SchemaError(violations))}), 400
        process.send_signal(signal.SIGHUP)
        return jsonify({"status": "reloading"}), 200


@app.route("/status", methods=["GET"])
def status():
    """Report, as JSON, whether a deploy is running."""
    return jsonify({"running": _gc_running()}), 200


def _deploy_config(config_path):
    """Return the running deploy's config with its `${VAR}`s expanded from the project's
    `.env` and this process's environment, as the Global Controller reads it."""
    # Not load_config: importing the project's .env here would leak into the next
    # deploy's environment.
    with open(config_path) as f:
        config = yaml.safe_load(f) or {}
    env = {**config_env.read_root_dotenv(config_path), **os.environ}
    return config_env.expand_env_value(config, env)


def _deploy_redis(config):
    """Return a client for the Redis the running deploy's Global Controller publishes
    to: this machine's Redis, on its config's `redis.port`."""
    port = (config.get("redis") or {}).get("port", 6379)
    return RedisClient(host=_redis_connect_host("localhost"), port=port)


@app.route("/endpoint", methods=["GET"])
def endpoint():
    """Return the endpoint record the running deploy's Global Controller published, so
    the CLI can find it from any directory; 409 if no deploy is running, 503 while it is
    not published yet or Redis cannot be read."""
    config_path = _config_path
    if config_path is None or not _gc_running():
        return jsonify({"error": "not running"}), 409
    try:
        record = read_endpoint_record(_deploy_redis(_deploy_config(config_path)))
    except (OSError, yaml.YAMLError, redis.RedisError) as e:
        return jsonify({"error": f"Could not read the endpoint record: {e}"}), 503
    if record is None:
        return jsonify({"error": "The endpoint is not published yet"}), 503
    return jsonify({"endpoint": record}), 200


@app.route("/runtime_status", methods=["GET"])
def runtime_status():
    """Return each agent's desired and running replica counts and why its last launch
    failed, if it did, and why each machine type's last machine failed to start; 409 if
    no deploy is running, 503 when Redis cannot be read."""
    config_path = _config_path
    if config_path is None or not _gc_running():
        return jsonify({"error": "not running"}), 409
    try:
        redis_client = _deploy_redis(_deploy_config(config_path))
        launch_errors = redis_client.hgetall(state.LAUNCH_ERRORS_KEY)
        machine_errors = redis_client.hgetall(state.MACHINE_ERRORS_KEY)
        agents = {}
        for agent_spec in read_config_specs(redis_client) or []:
            name = agent_spec["name"]
            agents[name] = {
                "desired_replicas": state.get_desired(redis_client, name),
                "running_replicas": len(list_replicas(redis_client, name)),
                "launch_error": launch_errors.get(name),
            }
    except (OSError, yaml.YAMLError, redis.RedisError) as e:
        return jsonify({"error": f"Could not read the runtime status: {e}"}), 503
    return jsonify({"agents": agents, "machine_errors": machine_errors}), 200


@app.route("/logs/<name>", methods=["GET"])
def logs(name):
    """Return the last `tail` lines of each running replica of agent `name`, or of the
    one replica whose ID is `name`, read on its machine; 409 if no deploy is running,
    404 naming the agents when `name` is neither, 503 when Redis cannot be read."""
    config_path = _config_path
    if config_path is None or not _gc_running():
        return jsonify({"error": "not running"}), 409
    tail = request.args.get("tail", "all")
    # It ends up in a shell command on a remote machine.
    if tail != "all" and not tail.isdigit():
        return jsonify({"error": "tail must be a number or `all`"}), 400
    try:
        config = _deploy_config(config_path)
        redis_client = _deploy_redis(config)
        names = [spec["name"] for spec in read_config_specs(redis_client) or []]
        matching = [
            replica
            for replica in list_replicas(redis_client)
            if name in (replica["agent_name"], replica_id_from_record(replica))
        ]
    except (OSError, yaml.YAMLError, redis.RedisError) as e:
        return jsonify({"error": f"Could not read the replicas: {e}"}), 503
    if not matching and name not in names:
        return jsonify(
            {
                "error": f"No agent or replica is named {name}; the agents are {', '.join(names)}"
            }
        ), 404
    run_cmd = partial(run_on_machine, config)
    jobs = {
        replica_id_from_record(replica): partial(
            replicas.log_tail, run_cmd, replica, tail
        )
        for replica in matching
    }
    logs = {
        replica_id: [f"Could not read the log: {error}"] if error else lines
        for replica_id, lines, error in run_in_parallel(jobs)
    }
    return jsonify({"logs": logs}), 200


if __name__ == "__main__":
    # No banner or request lines in the deploy log `canyonos deploy` replays on a failure.
    logging.getLogger("werkzeug").setLevel(logging.WARNING)
    run_simple("0.0.0.0", 8000, app, threaded=True)
