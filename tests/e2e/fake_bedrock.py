# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""A stand-in for Bedrock's Converse API. Every staged workflow's LLM gateway sends its
Bedrock calls here instead of AWS, so E2E runs never hit Bedrock's quota or bill.

Each prompt gets a fixed reply: the portfolio test query's holdings, no holdings for
a request that names no stocks, and otherwise a short review that approves."""

from __future__ import annotations

import functools
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .workflows import load_check, load_workflow

PORTFOLIO = load_check(load_workflow("portfolio"))
PORTFOLIO_PROMPT = "portfolio request into JSON"
REPLY = "The change is small and its tests pass.\nAPPROVE"


def reply_to(prompt: str) -> str:
    """The fixed reply to a prompt."""
    if PORTFOLIO_PROMPT in prompt:
        failing_query = PORTFOLIO.FAILING_QUERY[0]
        holdings = {} if failing_query in prompt else PORTFOLIO.EXPECTED_WEIGHTS
        return json.dumps({"holdings": holdings, "lookback_days": 365})
    return REPLY


class _Converse(BaseHTTPRequestHandler):
    def do_POST(self):
        """Answer a Converse call with its fixed reply and a word count as tokens."""
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        prompt = "".join(
            block.get("text", "")
            for message in body["messages"]
            for block in message["content"]
        )
        text = reply_to(prompt)
        tokens_in, tokens_out = len(prompt.split()), len(text.split())
        payload = json.dumps(
            {
                "output": {
                    "message": {"role": "assistant", "content": [{"text": text}]}
                },
                "stopReason": "end_turn",
                "usage": {
                    "inputTokens": tokens_in,
                    "outputTokens": tokens_out,
                    "totalTokens": tokens_in + tokens_out,
                },
                "metrics": {"latencyMs": 1},
            }
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, format, *args):
        """Skip the default line per request on stderr."""


@functools.cache
def url() -> str:
    """Start the fake once per process, on a free port on every host address, and return
    the address agent containers reach it at."""
    server = ThreadingHTTPServer(("0.0.0.0", 0), _Converse)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return f"http://host.docker.internal:{server.server_port}"
