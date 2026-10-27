# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Flask app: one catch-all route per provider prefix, all funneled through
``proxy_request``."""

from __future__ import annotations

import logging
from urllib.parse import urlsplit

import requests
from flask import Flask, jsonify, request

from canyonos_core.llm_gateway.config import Config
from canyonos_core.llm_gateway import routing
from canyonos_core.llm_gateway.core import proxy_request
from canyonos_core.llm_gateway.hooks import UPSTREAM_HEADER, Hooks
from canyonos_core.llm_gateway.providers import build_registry

log = logging.getLogger("llm_gateway")

ALL_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"]


def create_app(cfg: Config | None = None) -> Flask:
    """Build the gateway's Flask app, which forwards `/<provider>/...` to that LLM."""
    cfg = cfg or Config.from_env()
    app = Flask(__name__)
    registry = build_registry(cfg)

    hooks = Hooks(cfg)
    # Load llms.yaml rules from Redis and refresh them every few seconds in the background.
    routing.start_refresh(hooks._redis)

    @app.route("/healthz", methods=["GET"])
    def healthz():
        return jsonify(status="ok", providers=sorted(registry.keys()))

    @app.route("/<provider>/<path:subpath>", methods=ALL_METHODS)
    def dispatch(provider, subpath):
        prov = registry.get(provider)
        if prov is None:
            return (
                jsonify(
                    error=f"unknown provider '{provider}'",
                    known=sorted(registry.keys()),
                ),
                404,
            )
        try:
            return proxy_request(hooks, prov, subpath, request)
        except (requests.Timeout, requests.ConnectionError) as exc:
            log.exception("gateway error for %s/%s", provider, subpath)
            if isinstance(exc, requests.Timeout):
                limit = (
                    cfg.connect_timeout
                    if isinstance(exc, requests.ConnectTimeout)
                    else cfg.read_timeout
                )
                reason, status = f"the request timed out after {limit:g}s.", 504
            else:
                # The innermost error is the plain reason, e.g. "Connection refused".
                reason, status = exc, 502
                while cause := reason.__cause__ or reason.__context__:
                    reason = cause
            host = urlsplit(request.headers[UPSTREAM_HEADER]).hostname
            message = f"Could not reach {host}: {reason}"
            # boto3 reads the reason only from a top-level `message`.
            return jsonify(
                error={"message": message, "type": "gateway_error"}, message=message
            ), status
        except Exception as exc:  # surface upstream/adapter errors as 502
            log.exception("gateway error for %s/%s", provider, subpath)
            return jsonify(
                error={"message": str(exc), "type": "gateway_error"}, message=str(exc)
            ), 502

    return app
