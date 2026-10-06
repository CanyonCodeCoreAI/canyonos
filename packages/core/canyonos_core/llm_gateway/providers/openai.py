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

    def set_system(self, params, subpath, text):
        """Responses take `instructions`; chat completions take a leading system message."""
        if subpath.endswith("responses"):
            params["instructions"] = text
            return True
        if subpath.endswith("chat/completions"):
            messages = params.get("messages") or []
            rest = [m for m in messages if m.get("role") not in ("system", "developer")]
            params["messages"] = [{"role": "system", "content": text}, *rest]
            return True
        return False

    def merge_stream_usage(self, payload, usage):
        """Copy the token counts from a streamed OpenAI event into the running usage for
        the response. The Responses API carries them on the `response.completed` event's
        `response` object rather than at the top level."""
        response = payload.get("response") or {}
        event_usage = payload.get("usage") or response.get("usage")
        if event_usage:
            usage.update(event_usage)
