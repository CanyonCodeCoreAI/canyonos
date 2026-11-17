# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Adds the running future's ID and the agent and function making the call to every LLM
call an agent sends through the LLM gateway, so the gateway can record that call's tokens
on the future, apply the agent's rules and send the function's live prompt. The Local
Controller calls `install` once at startup."""

import importlib
import logging
from functools import wraps

from canyonos_core.llm_gateway.hooks import (
    AGENT_HEADER,
    FUNCTION_HEADER,
    FUTURE_ID_HEADER,
    LLM_PATHS,
)

log = logging.getLogger(__name__)

_PATCH_MARKER = "_canyonos_future_id_header_injection"


def install(get_future_id, get_function, get_agent):
    """Add the future-id, function and agent headers, read from the three getters, to
    Bedrock calls when boto3 is installed and to every POST to an OpenAI-format or
    Anthropic LLM path, which the proxy sends to the gateway when it names a model."""

    def add_header(headers):
        future_id = get_future_id()
        if future_id:
            headers[FUTURE_ID_HEADER] = future_id
        function = get_function()
        if function:
            headers[FUNCTION_HEADER] = function
        agent = get_agent()
        if agent:
            headers[AGENT_HEADER] = agent

    try:
        import boto3
    except ImportError:
        boto3 = None
    if boto3 is not None:
        session = boto3.Session()
        session.events.register_first(
            "before-sign.bedrock-runtime",
            lambda request, **kwargs: add_header(request.headers),
        )
        boto3.DEFAULT_SESSION = session
        log.info("Bedrock calls will carry the future-id header")

    # The SDKs vendor httpx under two distribution names, and a container may have either or both.
    for name in ("httpx", "httpx2"):
        try:
            _patch_httpx(importlib.import_module(name), add_header)
        except ImportError:
            continue


def _patch_httpx(httpx, add_header):
    """Wrap httpx's sync and async send so calls that may reach the gateway carry the
    headers. A failure here leaves the request as the agent sent it."""

    def add_if_gateway(request):
        try:
            if request.method == "POST" and any(
                p.search(request.url.path) for p in LLM_PATHS.values()
            ):
                add_header(request.headers)
        except Exception:
            log.warning(
                "Could not add the CanyonOS headers to this call", exc_info=True
            )

    sync_send = httpx.Client.send
    if not getattr(sync_send, _PATCH_MARKER, False):

        @wraps(sync_send)
        def send(self, request, *args, **kwargs):
            add_if_gateway(request)
            return sync_send(self, request, *args, **kwargs)

        setattr(send, _PATCH_MARKER, True)
        httpx.Client.send = send

    async_send = httpx.AsyncClient.send
    if not getattr(async_send, _PATCH_MARKER, False):

        @wraps(async_send)
        async def async_send_with_header(self, request, *args, **kwargs):
            add_if_gateway(request)
            return await async_send(self, request, *args, **kwargs)

        setattr(async_send_with_header, _PATCH_MARKER, True)
        httpx.AsyncClient.send = async_send_with_header
