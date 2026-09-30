"""Forwards gateway requests to the OpenAI API."""

from __future__ import annotations

from canyonos_core.llm_gateway.providers.base import (
    HttpProvider,
    UpstreamRequest,
    client_headers,
)


class OpenAIProvider(HttpProvider):
    """Forwards `/openai/...` requests to the OpenAI API."""

    name = "openai"

    def target(self, req, subpath, body):
        """Build the OpenAI request from the agent's request, swapping in the gateway's
        API key when one is configured."""
        headers = client_headers(req, drop=["authorization"])
        if self.cfg.openai.api_key:
            headers["Authorization"] = f"Bearer {self.cfg.openai.api_key}"
        return UpstreamRequest(
            method=req.method,
            url=f"{self.cfg.openai.upstream_base}/{subpath}",
            headers=headers,
            params=req.args.to_dict(flat=True),
        )

    def merge_stream_usage(self, payload, usage):
        """Copy the token counts from a streamed OpenAI event into the running usage for
        the response."""
        if payload.get("usage"):
            usage.update(payload["usage"])
