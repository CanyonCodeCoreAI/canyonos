"""Adds the running future's ID and the agent function making the call to every LLM call
an agent sends through the LLM gateway, so the gateway can record that call's tokens on the
future and send the function's live prompt. The Local Controller calls `install` once at
startup."""

import importlib
import logging
import os
from functools import wraps

from canyonos_core.llm_gateway.hooks import FUNCTION_HEADER, FUTURE_ID_HEADER

log = logging.getLogger(__name__)

_PATCH_MARKER = "_canyonos_future_id_header_injection"


def install(get_future_id, get_function=lambda: ""):
    """Add the future-id and function headers, read from `get_future_id()` and
    `get_function()`, to Bedrock calls when boto3 is installed and to OpenAI/Anthropic SDK
    calls bound for the gateway."""

    def add_header(headers):
        future_id = get_future_id()
        if future_id:
            headers[FUTURE_ID_HEADER] = future_id
        function = get_function()
        if function:
            headers[FUNCTION_HEADER] = function

    # Stub mode never calls AWS, but boto3 still needs some credentials to sign requests to
    # the local gateway, so supply throwaway ones. They never leave this machine.
    if os.getenv("CANYONOS_LLM_STUB_TEXT"):
        os.environ.setdefault("AWS_ACCESS_KEY_ID", "stub")
        os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "stub")
        os.environ.setdefault(
            "AWS_DEFAULT_REGION", os.getenv("AWS_REGION", "us-east-1")
        )

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
    """Wrap httpx's sync and async send so requests to the gateway carry the header."""

    def add_if_gateway(request):
        # The provider path prefixes identify our gateway without trusting a rewritten host.
        if request.url.path.startswith(("/openai", "/anthropic")):
            add_header(request.headers)

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
