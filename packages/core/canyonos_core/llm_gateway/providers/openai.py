# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Forwards OpenAI-format gateway requests to the provider the agent addressed."""

from __future__ import annotations

import json
from urllib.parse import urlsplit

from canyonos_core.llm_gateway.hooks import UPSTREAM_HEADER
from canyonos_core.llm_gateway.providers.base import (
    HttpProvider,
    UpstreamRequest,
    _parse_llm_stream_line,
    client_headers,
)

# Hosts that reject unknown fields like stream_options and already send usage in the last chunk.
NO_STREAM_OPTIONS_HOSTS = {"api.mistral.ai"}


class OpenAIProvider(HttpProvider):
    """Forwards OpenAI-format calls to the provider the agent addressed."""

    name = "openai"

    def target(self, req, subpath, body):
        """Build the request to the host the agent addressed, with the agent's own credentials."""
        return UpstreamRequest(
            method=req.method,
            url=f"{req.headers[UPSTREAM_HEADER]}/{subpath}",
            headers=client_headers(req, drop=[UPSTREAM_HEADER]),
            params=req.args.to_dict(flat=True),
        )

    def forward(self, req, subpath, body):
        """Send the request upstream, asking streamed completions for the token usage
        they leave out unless the caller sets `stream_options.include_usage`. A caller that
        did not ask never sees the usage chunk."""
        added_usage = False
        host = urlsplit(req.headers[UPSTREAM_HEADER]).hostname
        if subpath.endswith("completions") and host not in NO_STREAM_OPTIONS_HOSTS:
            params = json.loads(body)
            stream_options = params.get("stream_options") or {}
            if params.get("stream") and not stream_options.get("include_usage"):
                params["stream_options"] = {**stream_options, "include_usage": True}
                body = json.dumps(params).encode()
                added_usage = True
        pr = super().forward(req, subpath, body)
        if added_usage and pr.stream is not None:
            pr.stream = _drop_usage_chunk(pr.stream)
        return pr

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


def _drop_usage_chunk(stream):
    """Relay a streamed completion minus its usage-only chunk, whose empty `choices`
    breaks callers that read `choices[0]` on every chunk."""
    buf = b""
    try:
        for chunk in stream:
            buf += chunk
            *lines, buf = buf.split(b"\n")
            kept = b""
            for line in lines:
                payload = _parse_llm_stream_line(line)
                if isinstance(payload, dict) and payload.get("choices") == []:
                    continue
                kept += line + b"\n"
            if kept:
                yield kept
        if buf:
            yield buf
    finally:
        stream.close()
