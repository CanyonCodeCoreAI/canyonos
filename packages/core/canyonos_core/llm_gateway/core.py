# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""The single choke point every proxied call flows through."""

from __future__ import annotations

import json
import logging
import time
from typing import Optional
from urllib.parse import urlsplit

from flask import Response, stream_with_context

from canyonos_core.llm_gateway import pricing, prompts, routing
from canyonos_core.llm_gateway.hooks import FUNCTION_HEADER, UPSTREAM_HEADER, Ctx
from canyonos_core.llm_gateway.routing import AGENT_NAME, route, denied_response

try:
    from canyonos_core.controller import governance
except ImportError:
    import canyonos_governance as governance

log = logging.getLogger("llm_gateway")


def _guess_model(body: bytes) -> Optional[str]:
    """Best-effort model name from the JSON body, for logging/metrics.

    Never raises. Returns None for requests whose model isn't in the body
    (e.g. Bedrock, where it's in the path and already shown via the subpath).
    """
    try:
        model = json.loads(body).get("model")
        return model if isinstance(model, str) else None
    except Exception:
        return None


def _switch_model(provider, subpath: str, body: bytes, model: str) -> tuple[str, bytes]:
    """The call's subpath and body asking for `model` instead: Bedrock names the model in
    the path, every other provider in the body's `model` field."""
    if provider.name == "bedrock":
        try:
            _, op = provider._parse(subpath)
        except ValueError:
            return subpath, body
        return f"model/{model}/{op}", body
    try:
        payload = json.loads(body)
    except ValueError:
        return subpath, body
    # A body without a model is not a model call (a file upload, a model listing).
    if not isinstance(payload, dict) or payload.get("model") in (None, model):
        return subpath, body
    payload["model"] = model
    return subpath, json.dumps(payload).encode("utf-8")


def proxy_request(hooks, provider, subpath, flask_request):
    """Forward one agent request to its LLM provider, on the model governance switched
    this agent to if any, and record its token usage on the calling future."""
    body = flask_request.get_data()
    target = governance.model_for(routing.rules, AGENT_NAME) if routing.rules else None
    if target:
        switched = _switch_model(provider, subpath, body, target)
        if switched != (subpath, body):
            subpath, body = switched
            log.info("Governance switched %s to %s", AGENT_NAME, target)
    prompt_name = f"{AGENT_NAME}.{flask_request.headers.get(FUNCTION_HEADER)}"
    body, prompt_version = prompts.apply(provider, prompt_name, subpath, body)
    ctx = Ctx(
        provider=provider.name,
        method=flask_request.method,
        subpath=subpath,
        body=body,
        headers={k.lower(): v for k, v in flask_request.headers.items()},
        t0=time.monotonic(),
        model=_guess_model(body),
        prompt_name=prompt_name if prompt_version else None,
        prompt_version=prompt_version,
        price_prefix=pricing.LLM_HOSTS.get(
            pricing.llm_host(
                urlsplit(flask_request.headers.get(UPSTREAM_HEADER, "")).hostname
            )
        ),
    )
    hooks.on_request(ctx)
    # Policy/routing call; all routing and policy logic lives in routing.py.
    denied = route(hooks._extract_model_id(ctx), body, ctx.price_prefix)
    if denied:
        pr = denied_response(denied)
    else:
        pr = provider.forward(flask_request, subpath, body)

    stream = pr.stream
    if stream is not None:
        # Streamed responses: relay chunks as they arrive, and only take telemetry when the whole response is done.
        def relay():
            try:
                yield from stream
            finally:
                hooks.on_response(ctx, pr)

        return Response(
            stream_with_context(relay()),
            status=pr.status,
            headers=pr.headers,
            direct_passthrough=True,
        )

    hooks.on_response(ctx, pr)
    return Response(pr.content, status=pr.status, headers=pr.headers)
