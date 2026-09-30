"""
CanyonOS Deploy Module

Provides `deploy()` to expose a workflow function as an async REST API endpoint.
Requests are assigned a unique ID and processed asynchronously. Results are
stored in Redis and can be polled via GET /status/<request_id>.

Usage:
    import canyonos_core

    def my_workflow(query: str):
        finance = FinanceAgent()
        price = finance.get_stock_price(ticker=query)
        return {"price": price.value()}

    canyonos_core.deploy(my_workflow, port=8080)
"""

try:
    import canyonos_core.controller.canyonos_context as canyonos_context
except ImportError:
    import canyonos_context
import json
import logging
import os
import traceback
import uuid
from typing import Any

from flask import Flask, request, jsonify
from werkzeug.serving import WSGIRequestHandler

# Try to import from absolute package (local install) or fallback to flat file (Docker container)
try:
    from canyonos_core.controller.utils.redis_client import RedisClient
except ImportError:
    from redis_client import RedisClient
try:
    from canyonos_core.controller.future import Future
except ImportError:
    from future import Future

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

FUTURE_RESULT_TIMEOUT_SECONDS = 300

# Allows the workflow to have a future: the launcher sets these to its in-process local controller.
controller: Any = None
workflow_name = None


def deploy(workflow_fn, port=8080, host="0.0.0.0", redis_host=None, redis_port=None):
    """
    Deploy a workflow function as a REST API endpoint.

    Creates a Flask server with:
        POST /<workflow_fn_name>  — accepts JSON args, returns {"request_id": "<id>"} (HTTP 202)
        GET  /status/<request_id> — returns status and result

    Args:
        workflow_fn:  The workflow function to expose.
        port:         Port for the REST server (default: 8080).
        host:         Host to bind to (default: 0.0.0.0).
        redis_host:   Redis host (default: from env or localhost).
        redis_port:   Redis port (default: from env or 6379).
    """
    redis_host = redis_host or os.environ.get("CANYONOS_REDIS_HOST", "localhost")
    redis_port = redis_port or int(os.environ.get("CANYONOS_REDIS_PORT", 6379))
    redis_client = RedisClient(host=redis_host, port=redis_port)

    fn_name = workflow_fn.__name__
    app = Flask(f"canyonos-{fn_name}")

    def _resolved(value):
        """Pull any Future the workflow handed back instead of a value.

        A future is a reference; Redis holds the computed result. Walking the
        payload keeps a workflow that returns `{"a": future}` working, not just
        one that returns the future bare.
        """
        if isinstance(value, Future):
            return value.value(timeout=FUTURE_RESULT_TIMEOUT_SECONDS)
        if isinstance(value, dict):
            return {k: _resolved(v) for k, v in value.items()}
        if isinstance(value, (list, tuple)):
            return type(value)(_resolved(v) for v in value)
        return value

    def run(**kwargs):
        """Run the workflow; the controller stores what it returns on the workflow's future."""
        request_id = canyonos_context.get_request_id()
        try:
            logger.info("Executing workflow '%s' for request %s", fn_name, request_id)
            result = _resolved(workflow_fn(**kwargs))

            # Serialize the result
            output_payload = result if isinstance(result, dict) else {"value": result}
            try:
                serialized = json.dumps(output_payload)
            except TypeError as e:
                # Naming the offender matters: an unserializable payload used to
                # surface as a bare "Object of type X is not JSON serializable"
                # that replaced whatever the request had actually failed on.
                raise TypeError(
                    f"workflow '{fn_name}' returned a result that cannot be sent "
                    f"as JSON: {e}"
                ) from e

            logger.info("Request %s completed successfully.", request_id)
            return serialized

        except Exception as e:
            logger.error("Request %s failed: %s", request_id, e)
            logger.error(traceback.format_exc())
            # The future's own error field holds only the type name
            redis_client.set(f"request:{request_id}:error", str(e))
            raise
        finally:
            redis_client.sadd("request:completed", request_id)

    controller.agent = type(fn_name, (), {fn_name: staticmethod(run)})()

    @app.route(f"/{fn_name}", methods=["POST"])
    def handle_workflow():
        """Accept a workflow request, dispatch async, return request ID."""
        # An empty body is a valid no-args call; a malformed one is rejected with the
        # real parse error. Parsed with stdlib json because Flask replaces decode errors
        # with a generic "Bad Request".
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

        # Extract policy context (if provided) before passing to workflow
        context = kwargs.pop("_context", {})

        request_id = uuid.uuid4().hex

        # Store context in Redis so Local Controllers can look it up
        if context:
            redis_client.set(f"request:{request_id}:context", json.dumps(context))

        canyonos_context.set_request_id(request_id)
        future = Future(
            parent=None, service=workflow_name or fn_name, method=fn_name, args=kwargs
        )
        redis_client.set(f"request:{request_id}:future", future.id)

        logger.info(
            "Queued request %s for workflow '%s' with args: %s",
            request_id,
            fn_name,
            kwargs,
        )

        return jsonify({"request_id": request_id}), 202

    @app.route("/status/<request_id>", methods=["GET"])
    def get_status(request_id):
        """Check the status of a workflow request."""
        future_id = redis_client.get(f"request:{request_id}:future")
        if future_id is None:
            # Cleanup expires a finished request's keys; durable history lives in the external API.
            return jsonify({"error": "Request not found"}), 404

        record = redis_client.hgetall(f"future:{future_id}")
        response = {"request_id": request_id, "status": "pending"}

        if str(record.get("failed")) == "1":
            response["status"] = "error"
            response["error"] = redis_client.get(
                f"request:{request_id}:error"
            ) or record.get("error")
        elif record.get("result"):
            response["status"] = "done"
            response["result"] = json.loads(record["result"])

        return jsonify(response), 200

    logger.info(
        "Deploying workflow '%s' at http://%s:%d/%s", fn_name, host, port, fn_name
    )
    logger.info("Status endpoint: GET http://%s:%d/status/<request_id>", host, port)

    app.run(
        host=host,
        port=port,
        threaded=True,
        request_handler=type(
            "_TimeoutWSGIRequestHandler", (WSGIRequestHandler,), {"timeout": 30}
        ),
    )
