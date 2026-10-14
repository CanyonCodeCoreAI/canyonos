"""The endpoint container's HTTP server and the controller that forwards its calls.

`main` runs a local controller with no agent, which routes each call to a replica
of the served agent, and gunicorn workers built by `worker_app`, which queue those
calls and report their results.
"""

import json
import logging
import os
import socket
import subprocess
import sys
import threading
import time
import uuid

from flask import Flask, jsonify, request

from canyonos_core.controller import canyonos_context
from canyonos_core.controller.future import Future
from canyonos_core.controller.local_controller import LocalController
from canyonos_core.endpoint import ENDPOINT_CPUS, ENDPOINT_PORT

logger = logging.getLogger(__name__)

# How many requests each worker serves at once; the rest wait for a free thread.
WORKER_THREADS = 16


def create_app(agent, method, redis_client):
    """Build the Flask app that queues calls to the agent's method at `POST /<method>`
    and reports their results at `GET /status/<request_id>`."""
    app = Flask("canyonos-endpoint")

    @app.errorhandler(404)
    def not_found(_error):
        """Answer an unknown route with a JSON error naming the served route."""
        return jsonify(
            {"error": f"Not found; this endpoint serves POST /{method}"}
        ), 404

    @app.errorhandler(405)
    def method_not_allowed(_error):
        """Answer a known route called with the wrong HTTP method with a JSON error."""
        return jsonify({"error": "Method not allowed"}), 405

    @app.route(f"/{method}", methods=["POST"])
    def handle_request():
        # Parsed with stdlib json because Flask replaces decode errors with a
        # generic "Bad Request".
        raw_body = request.get_data(cache=True)
        if raw_body:
            try:
                kwargs = json.loads(raw_body)
            except json.JSONDecodeError:
                logger.warning("Invalid JSON in request body.", exc_info=True)
                return jsonify({"error": "Invalid JSON in request body"}), 400
            if not isinstance(kwargs, dict):
                return jsonify({"error": "Request body must be a JSON object"}), 400
        else:
            kwargs = {}

        context = kwargs.pop("_context", {})
        request_id = uuid.uuid4().hex
        if context:
            redis_client.set(f"request:{request_id}:context", json.dumps(context))

        canyonos_context.set_request_id(request_id)
        future = Future(parent=None, service=agent, method=method, args=kwargs)
        redis_client.set(f"request:{request_id}:future", future.id)

        logger.info(
            "Queued request %s for %s.%s with arguments %s",
            request_id,
            agent,
            method,
            sorted(kwargs),
        )
        return jsonify({"request_id": request_id}), 202

    @app.route("/status/<request_id>", methods=["GET"])
    def get_status(request_id):
        """Report a request's status, and its result or error once it has one."""
        future_id = redis_client.get(f"request:{request_id}:future")
        if future_id is None:
            # Cleanup expires a finished request's keys; durable history lives in
            # the external API.
            return jsonify({"error": "Request not found"}), 404

        record = redis_client.hgetall(f"future:{future_id}")
        response = {"request_id": request_id, "status": "pending"}

        if str(record.get("failed")) == "1":
            response["status"] = "error"
            response["error"] = record.get("error_message") or record.get("error")
        elif record.get("result"):
            response["status"] = "done"
            response["result"] = json.loads(record["result"])

        return jsonify(response), 200

    return app


def worker_app():
    """Build the app each gunicorn worker serves from the container's env."""
    return create_app(
        os.environ["CANYONOS_ENDPOINT_AGENT"],
        os.environ["CANYONOS_ENDPOINT_METHOD"],
        Future.redis,
    )


def main():
    """Start the forwarding local controller and a gunicorn worker per CPU serving the
    endpoint; report healthy once its port accepts connections, and exit, reported
    failed, when gunicorn or the controller stops."""
    logging.basicConfig(level=logging.INFO)
    controller = LocalController(publish_ready=False)
    server = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "gunicorn",
            "--bind",
            f"0.0.0.0:{ENDPOINT_PORT}",
            "--workers",
            str(ENDPOINT_CPUS),
            "--worker-class",
            "gthread",
            "--threads",
            str(WORKER_THREADS),
            "canyonos_core.endpoint.app:worker_app()",
        ]
    )

    threading.Thread(
        target=controller.run, name="endpoint-controller", daemon=True
    ).start()
    while server.poll() is None:
        try:
            socket.create_connection(("127.0.0.1", ENDPOINT_PORT), timeout=1).close()
        except OSError:
            time.sleep(0.1)
            continue
        controller.mark_ready()
        break
    server.wait()
    controller.mark_failed()
    sys.exit(server.returncode)
