"""Forwards gateway requests to the Anthropic API."""

from __future__ import annotations

from canyonos_core.llm_gateway.providers.base import (
    HttpProvider,
    UpstreamRequest,
    client_headers,
)


class AnthropicProvider(HttpProvider):
    """Forwards `/anthropic/...` requests to the Anthropic API."""

    name = "anthropic"

    def target(self, req, subpath, body):
        """Build the Anthropic request from the agent's request, swapping in the gateway's
        API key when one is configured."""
        headers = client_headers(req, drop=["x-api-key", "authorization"])
        if self.cfg.anthropic.api_key:
            headers["x-api-key"] = self.cfg.anthropic.api_key
        # `anthropic-version` is supplied by the SDK and passes through untouched.
        return UpstreamRequest(
            method=req.method,
            url=f"{self.cfg.anthropic.upstream_base}/{subpath}",
            headers=headers,
            params=req.args.to_dict(flat=True),
        )

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
