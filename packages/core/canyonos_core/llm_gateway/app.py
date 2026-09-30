"""Flask app: one catch-all route per provider prefix, all funneled through
``proxy_request``."""

from __future__ import annotations

import logging

from flask import Flask, jsonify, request

from canyonos_core.llm_gateway.config import Config
from canyonos_core.llm_gateway import routing
from canyonos_core.llm_gateway.core import proxy_request
from canyonos_core.llm_gateway.providers import build_registry

log = logging.getLogger("llm_gateway")

ALL_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"]


def create_app(cfg: Config | None = None) -> Flask:
    """Build the gateway's Flask app, which forwards `/<provider>/...` to that LLM."""
    cfg = cfg or Config.from_env()
    app = Flask(__name__)
    registry = build_registry(cfg)

    # Initialize hooks with config for Redis
    from canyonos_core.llm_gateway import hooks as hooks_module

    hooks_module.hooks = hooks_module.Hooks(cfg)
    # Load llms.yaml rules from Redis and refresh them every few seconds in the background.
    routing.start_refresh(hooks_module.hooks._redis)

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
            return proxy_request(prov, subpath, request)
        except Exception as exc:  # surface upstream/adapter errors as 502
            log.exception("gateway error for %s/%s", provider, subpath)
            return jsonify(error="gateway_error", detail=str(exc)), 502

    return app
