# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Checks an agent replica's LLM gateway and proxy from inside its container.

Runs a fake OpenAI-compatible server in the container, reached by the container's
hostname so calls go through the proxy, and checks that LLM calls reach the gateway
(their tokens land on the future in Redis), that streams arrive chunk by chunk, that a
child process is caught too, that other calls pass through, that the prices the global
controller published load, and that a killed gateway comes back.

Usage (inside the replica): python gateway_check.py
"""

import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import redis

FAKE_PORT = 18080
FAKE_URL = f"http://{socket.gethostname()}:{FAKE_PORT}"
GATEWAY_HEALTH = "http://127.0.0.1:8081/healthz"
GATEWAY_PYTHON = "/opt/canyonos-gateway/bin/python"
RESTART_TIMEOUT = 90
USAGE = {"prompt_tokens": 3, "completion_tokens": 5, "total_tokens": 8}
seen = []


class FakeProvider(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def send_chunk(self, data):
        self.wfile.write(b"%x\r\n%s\r\n" % (len(data), data))
        self.wfile.flush()

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])) or b"{}")
        seen.append((self.path, body))
        if not body.get("stream"):
            out = json.dumps(
                {"model": body.get("model"), "choices": [], "usage": USAGE}
            )
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(out)))
            self.end_headers()
            self.wfile.write(out.encode())
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        for word in ("one", "two", "three"):
            delta = {"choices": [{"index": 0, "delta": {"content": word}}]}
            self.send_chunk(f"data: {json.dumps(delta)}\n\n".encode())
            time.sleep(1)
        if (body.get("stream_options") or {}).get("include_usage"):
            self.send_chunk(
                f"data: {json.dumps({'choices': [], 'usage': USAGE})}\n\n".encode()
            )
        self.send_chunk(b"data: [DONE]\n\n")
        self.send_chunk(b"")


def post(path, body, future_id):
    """POST through the container's proxy, as any agent code would."""
    request = urllib.request.Request(
        FAKE_URL + path,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "x-canyonos-future-id": future_id},
        method="POST",
    )
    return urllib.request.urlopen(request, timeout=30)


def tokens(future_id):
    """The input and output tokens the gateway recorded on a future, waiting briefly since
    a stream's are written after its last chunk; None if nothing was recorded."""
    for _ in range(10):
        future = REDIS.hgetall(f"future:{future_id}")
        if "input_token_count" in future:
            return int(future["input_token_count"]), int(future["output_token_count"])
        time.sleep(0.5)
    return None


def check(name, ok, detail=""):
    print(f"{'ok' if ok else 'FAIL'}: {name} {detail}".rstrip())
    if not ok:
        sys.exit(1)


def gateway_pids():
    pids = []
    for pid in filter(str.isdigit, os.listdir("/proc")):
        try:
            with open(f"/proc/{pid}/cmdline", "rb") as f:
                if b"-m\x00canyonos_core.llm_gateway" in f.read():
                    pids.append(int(pid))
        except OSError:
            pass
    return pids


REDIS = redis.Redis(
    host=os.environ["CANYONOS_REDIS_HOST"],
    port=int(os.environ["CANYONOS_REDIS_PORT"]),
    decode_responses=True,
)
threading.Thread(
    target=ThreadingHTTPServer(("0.0.0.0", FAKE_PORT), FakeProvider).serve_forever,
    daemon=True,
).start()

future = uuid.uuid4().hex
post("/v1/chat/completions", {"model": "fake-model", "messages": []}, future).read()
check(
    "an OpenAI-format call reaches the gateway",
    tokens(future) == (3, 5),
    tokens(future),
)

future = uuid.uuid4().hex
arrivals, lines = [], []
with post(
    "/v1/chat/completions", {"model": "fake-model", "stream": True}, future
) as response:
    for line in response:
        if line.startswith(b"data: {"):
            arrivals.append(time.monotonic())
            lines.append(line)
check("a stream arrives chunk by chunk", arrivals[-1] - arrivals[0] >= 1.5, arrivals)
check(
    "the gateway asked for usage",
    seen[-1][1].get("stream_options", {}).get("include_usage") is True,
)
check("the usage chunk is not relayed", not any(b'"usage"' in line for line in lines))
check("the stream's tokens are recorded", tokens(future) == (3, 5), tokens(future))

future = uuid.uuid4().hex
code = (
    "import json, sys, urllib.request; "
    f"r = urllib.request.Request({FAKE_URL + '/v1/chat/completions'!r}, "
    "data=json.dumps({'model': 'fake-model'}).encode(), "
    f"headers={{'Content-Type': 'application/json', 'x-canyonos-future-id': {future!r}}}, "
    "method='POST'); urllib.request.urlopen(r, timeout=30).read()"
)
subprocess.run([sys.executable, "-c", code], check=True, timeout=60)
check(
    "a child process's call reaches the gateway",
    tokens(future) == (3, 5),
    tokens(future),
)

future = uuid.uuid4().hex
post("/v3/collectors/1/responses", {"answers": []}, future).read()
check("a non-LLM POST reaches its host", seen[-1][0] == "/v3/collectors/1/responses")
check(
    "a non-LLM POST skips the gateway",
    tokens(future) is None and not REDIS.exists(f"future:{future}"),
)

prices = subprocess.run(
    [
        GATEWAY_PYTHON,
        "-c",
        "import json, os, redis; from canyonos_core.llm_gateway import pricing; "
        "r = redis.Redis(host=os.environ['CANYONOS_REDIS_HOST'], "
        "port=int(os.environ['CANYONOS_REDIS_PORT']), decode_responses=True); "
        "published = json.loads(r.get(pricing.LLM_PRICES_KEY) or '{}'); "
        "prefixes = set(pricing.LLM_HOSTS.values()); "
        "key = next(k for k in published if k.split('/', 1)[0] in prefixes); "
        "pricing.load_published_prices(r); "
        "got = pricing.token_prices(key.split('/', 1)[1], key.split('/', 1)[0])[:2]; "
        "want = (published[key]['input_cost_per_million_tokens'], "
        "published[key]['output_cost_per_million_tokens']); "
        "print(len(published), key, got == want)",
    ],
    cwd="/app",
    capture_output=True,
    text=True,
    timeout=60,
)
check(
    "the published LiteLLM prices load",
    prices.stdout.strip().endswith("True"),
    prices.stdout + prices.stderr,
)

before = gateway_pids()
check("the gateway is running", len(before) == 1, before)
os.kill(before[0], signal.SIGKILL)
deadline = time.monotonic() + RESTART_TIMEOUT
restarted = False
while not restarted and time.monotonic() < deadline:
    time.sleep(1)
    try:
        urllib.request.urlopen(GATEWAY_HEALTH, timeout=2).read()
        restarted = gateway_pids() not in ([], before)
    except OSError:
        pass
check("the gateway restarts after a kill", restarted, gateway_pids())
future = uuid.uuid4().hex
post("/v1/chat/completions", {"model": "fake-model", "messages": []}, future).read()
check("a call reaches the restarted gateway", tokens(future) == (3, 5), tokens(future))
