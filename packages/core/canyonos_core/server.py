# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""HTTP server that runs in the Global Controller container; the CLI calls it to start,
stop, and check a deploy."""

import os
import signal
import subprocess
import sys
import threading

import redis
import yaml
from flask import Flask, jsonify, request

from canyonos_core.cli import _artifact_prefix
from canyonos_core.controller.controller_context import _redis_connect_host
from canyonos_core.controller.utils.redis_client import RedisClient
from canyonos_core.endpoint import read_endpoint_record

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
    # Resolved with canyonos' own artifact-layout rule rather than a second copy
    # of it, so a `.canyon` project works when the client sends no config_path.
    config_path = data.get("config_path") or os.path.join(
        _artifact_prefix(WORKSPACE_DIR), "config", "global_controller.yaml"
    )
    # realpath, not normpath: /workspace holds a copy of the user's project, which may symlink out.
    workspace_root = os.path.realpath(WORKSPACE_DIR)
    full_path = os.path.realpath(os.path.join(workspace_root, config_path))
    if not full_path.startswith(workspace_root + os.sep):
        return jsonify({"error": "config_path must stay inside the workspace"}), 400

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
            [sys.executable, "-m", "canyonos_core.cli", "deploy", "-c", config_path],
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


@app.route("/status", methods=["GET"])
def status():
    """Report, as JSON, whether a deploy is running."""
    return jsonify({"running": _gc_running()}), 200


def _deploy_redis(config_path):
    """Return a client for the Redis the running deploy's Global Controller publishes
    to: this machine's Redis, on its config's `redis.port`."""
    # Raw YAML, not load_config: importing the project's .env here would leak into the
    # next deploy's environment. Ports cannot be ${VAR} references, so none is missed.
    with open(config_path) as f:
        config = yaml.safe_load(f) or {}
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
        record = read_endpoint_record(_deploy_redis(config_path))
    except (OSError, yaml.YAMLError, redis.RedisError) as e:
        return jsonify({"error": f"Could not read the endpoint record: {e}"}), 503
    if record is None:
        return jsonify({"error": "The endpoint is not published yet"}), 503
    return jsonify({"endpoint": record}), 200


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8000)
