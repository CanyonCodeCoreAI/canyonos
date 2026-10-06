"""The single choke point every proxied call flows through."""

from __future__ import annotations

import json
import time
from typing import Optional

from flask import Response, stream_with_context

from canyonos_core.llm_gateway import prompts
from canyonos_core.llm_gateway.hooks import FUNCTION_HEADER, Ctx
from canyonos_core.llm_gateway.routing import AGENT_NAME, route, denied_response


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


def proxy_request(hooks, provider, subpath, flask_request):
    """Forward one agent request to its LLM provider (or return canned text when
    `canyonos test` stubs LLMs) and record its token usage on the calling future."""
    prompt_name = f"{AGENT_NAME}.{flask_request.headers.get(FUNCTION_HEADER)}"
    body, prompt_version = prompts.apply(
        provider, prompt_name, subpath, flask_request.get_data()
    )
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
    )
    hooks.on_request(ctx)
    # Policy/routing call; all routing and policy logic lives in routing.py.
    denied = route(hooks._extract_model_id(ctx), body)

    # Test mode: if CANYONOS_LLM_STUB_TEXT is set, return canned text instead of
    # calling the real upstream. Telemetry hooks still fire so the whole pipeline
    # is exercised end-to-end without cloud credentials.
    from canyonos_core.llm_gateway.stub import build_stub, stub_text

    # Empty string (the runtime's explicit "disabled" value) is falsy, so only a
    # non-empty stub text -- which only `canyonos test` sets -- enables stubbing.
    _stub = stub_text()
    if denied:
        pr = denied_response(denied)
    elif _stub:
        pr = build_stub(provider.name, subpath, _stub, body=body)
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
