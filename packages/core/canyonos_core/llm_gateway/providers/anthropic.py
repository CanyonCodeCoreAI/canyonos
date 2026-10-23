# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Forwards gateway requests to the Anthropic API."""

from __future__ import annotations

from canyonos_core.llm_gateway.hooks import UPSTREAM_HEADER
from canyonos_core.llm_gateway.providers.base import (
    HttpProvider,
    UpstreamRequest,
    client_headers,
)


class AnthropicProvider(HttpProvider):
    """Forwards Anthropic Messages API calls to the host the agent addressed."""

    name = "anthropic"

    def target(self, req, subpath, body):
        """Build the request to the host the agent addressed, with the agent's own credentials."""
        # `anthropic-version` is supplied by the SDK and passes through untouched.
        return UpstreamRequest(
            method=req.method,
            url=f"{req.headers[UPSTREAM_HEADER]}/{subpath}",
            headers=client_headers(req, drop=[UPSTREAM_HEADER]),
            params=req.args.to_dict(flat=True),
        )

    def set_system(self, params, subpath, text):
        """The Messages API takes the system prompt as its top-level `system`."""
        if not subpath.endswith("messages"):
            return False
        params["system"] = text
        return True

    def merge_stream_usage(self, payload, usage):
        # Input counts arrive on message_start and output counts on message_delta, so neither event alone is enough.
        """Merge the token counts from one streamed Anthropic event into the running
        usage for the response."""
        if payload.get("type") == "message_start":
            incoming = (payload.get("message") or {}).get("usage") or {}
        elif payload.get("type") == "message_delta":
            incoming = payload.get("usage") or {}
        else:
            return
        for key, value in incoming.items():
            if value:
                usage[key] = value
