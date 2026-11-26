# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Checks an agent replica's LLM gateway and proxy from inside its container.

Runs a fake OpenAI-compatible server in the container, reached by the container's
hostname so calls go through the proxy, and checks that LLM calls reach the gateway
(their tokens land on the future in Redis), that streams arrive chunk by chunk, that a
child process is caught too, that one started during a future is recorded on that
future and one started outside a future keeps its environment, that proxy credentials
naming no future are dropped, that the gateway's /future/<id>/<agent>/ route records
on that future, that other calls pass through, that the prices the global controller
published load, and that a killed gateway comes back. The futures it records tokens on
are deleted from Redis when it ends, whether it passed or not.

Usage (inside the replica): python gateway_check.py
"""

import json
import os
import secrets
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import redis

FAKE_PORT = 18080
FAKE_URL = f"http://{socket.gethostname()}:{FAKE_PORT}"
GATEWAY = "http://127.0.0.1:8081"
GATEWAY_HEALTH = f"{GATEWAY}/healthz"
GATEWAY_PYTHON = "/opt/canyonos-gateway/bin/python"
RESTART_TIMEOUT = 90
CONFIG_TIMEOUT = 20
USAGE = {"prompt_tokens": 3, "completion_tokens": 5, "total_tokens": 8}
WORDS = ("one", "two", "three")
seen = []
# The headers of each call the fake provider gets, kept apart from `seen`.
seen_headers = []
created = []
# An LLM call from a child process, with no future-id header of its own.
CHILD_CALL = (
    "import json, urllib.request; "
    f"r = urllib.request.Request({FAKE_URL + '/v1/chat/completions'!r}, "
    "data=json.dumps({'model': 'fake-model'}).encode(), "
    "headers={'Content-Type': 'application/json'}, method='POST'); "
    "urllib.request.urlopen(r, timeout=30).read()"
)


class FakeProvider(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format, *args):
        pass

    def send_chunk(self, data):
        self.wfile.write(b"%x\r\n%s\r\n" % (len(data), data))
        self.wfile.flush()

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])) or b"{}")
        seen.append((self.path, body))
        seen_headers.append({name.lower() for name in self.headers})
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
        for word in WORDS:
            delta = {"choices": [{"index": 0, "delta": {"content": word}}]}
            self.send_chunk(f"data: {json.dumps(delta)}\n\n".encode())
            time.sleep(1)
        if (body.get("stream_options") or {}).get("include_usage"):
            self.send_chunk(
                f"data: {json.dumps({'choices': [], 'usage': USAGE})}\n\n".encode()
            )
        self.send_chunk(b"data: [DONE]\n\n")
        self.send_chunk(b"")


def new_future():
    """A future id for one check, noted so it is deleted at the end."""
    created.append(uuid.uuid4().hex)
    return created[-1]


def new_real_future():
    """A future id in the form futures really get (16 hex digits, controller/future.py),
    which the proxy needs before it takes one from a child's proxy credentials; noted so
    it is deleted at the end."""
    created.append(secrets.token_hex(8))
    return created[-1]


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
        if "gen_ai.usage.input_tokens" in future:
            return int(future["gen_ai.usage.input_tokens"]), int(
                future["gen_ai.usage.output_tokens"]
            )
        time.sleep(0.5)
    return None


def check(name, ok, detail=""):
    print(f"{'ok' if ok else 'FAIL'}: {name} {detail}".rstrip())
    if not ok:
        sys.exit(1)


def _refusal(error):
    try:
        return json.loads(error.read().decode())
    except (UnicodeDecodeError, ValueError):
        return {}


def _wait_for_denial(name, body, reason_prefix, reason_suffix=None):
    """Wait for the gateway's Redis refresh, then prove its refused call was not forwarded."""
    deadline = time.monotonic() + CONFIG_TIMEOUT
    last_response = None
    while time.monotonic() < deadline:
        future = new_future()
        before = len(seen)
        try:
            post("/v1/chat/completions", body, future).read()
        except urllib.error.HTTPError as error:
            refusal = _refusal(error)
            reason = refusal.get("message")
            matched = isinstance(reason, str) and (
                reason == reason_prefix
                if reason_suffix is None
                else reason.startswith(reason_prefix) and reason.endswith(reason_suffix)
            )
            if error.code == 403 and matched:
                check(
                    f"{name} returns the policy reason",
                    refusal.get("error", {}).get("message") == reason,
                    refusal,
                )
                check(
                    f"{name} never reaches its provider",
                    len(seen) == before,
                    seen[before:],
                )
                return
            # The gateway may still have the prior policy between Redis refreshes.
            # In particular, the first new 403 can name the previous policy.
            last_response = {"code": error.code, "refusal": refusal}
        except OSError as error:
            check(f"{name} reaches the gateway", False, error)
        else:
            last_response = {"code": 200, "provider_calls": seen[before:]}
        time.sleep(0.5)
    check(f"{name} refreshes in time", False, last_response)


def _wait_for_allowed_control(body):
    """Wait for an allowed config and prove the one successful request reaches the fake host."""
    deadline = time.monotonic() + CONFIG_TIMEOUT
    last_refusal = None
    while time.monotonic() < deadline:
        future = new_future()
        before = len(seen)
        try:
            post("/v1/chat/completions", body, future).read()
        except urllib.error.HTTPError as error:
            last_refusal = _refusal(error)
            time.sleep(0.5)
            continue
        except OSError as error:
            check("the allowed control reaches the gateway", False, error)
        check(
            "the allowed control reaches its provider",
            len(seen) == before + 1 and seen[-1][1] == body,
            seen[before:],
        )
        return
    check("the allowed control refreshes in time", False, last_refusal)


def _set_llms(config):
    REDIS.set("llms:config", json.dumps(config))


def _restore_llms(raw):
    if raw is None:
        REDIS.delete("llms:config")
    else:
        REDIS.set("llms:config", raw)


def check_llm_policy():
    """Exercise configured policy through the deployed gateway and fake upstream."""
    saved = REDIS.get("llms:config")
    agent = os.environ["CANYONOS_AGENT_NAME"]
    try:
        denied_model = "fake-model"
        _set_llms(
            {
                "restricted": {
                    "model_id": denied_model,
                    "agents": {"AnotherAgent": None},
                }
            }
        )
        _wait_for_denial(
            "an agent denied a model",
            {"model": denied_model, "messages": []},
            f"canyonos denied: {agent} is not allowed to use restricted",
        )

        cap = 0.0001
        _set_llms(
            {
                "capped": {
                    "model_id": "gpt-5-nano",
                    "max_tokens": 1000,
                    "agents": {agent: cap},
                }
            }
        )
        _wait_for_denial(
            "a call over its per-request cap",
            {"model": "gpt-5-nano", "messages": [], "max_tokens": 1000},
            f"canyonos denied: {agent} call to capped could cost up to $",
            f"over its ${cap} per-request cap",
        )

        _set_llms(
            {
                "allowed": {
                    "model_id": "gpt-5-nano",
                    "agents": {agent: None},
                }
            }
        )
        _wait_for_allowed_control(
            {"model": "gpt-5-nano", "messages": [], "max_tokens": 1000}
        )
    finally:
        _restore_llms(saved)


def check_child_processes():
    """Install the subprocess wrapper the Local Controller installs, standing in for a
    running future, and check what a child gets when started during one and outside
    one; subprocess is put back as it was for the checks that follow."""
    import gateway_headers  # the image's flat module, as local_controller.py imports it

    running = {"future": "", "agent": ""}
    original_init = subprocess.Popen.__init__
    gateway_headers.install_child_env(
        lambda: running["future"], lambda: running["agent"]
    )
    try:
        future = new_real_future()
        running.update(future=future, agent=os.environ["CANYONOS_AGENT_NAME"])
        subprocess.run([sys.executable, "-c", CHILD_CALL], check=True, timeout=60)
        check(
            "a child process's call is recorded on its future",
            tokens(future) == (3, 5),
            tokens(future),
        )

        running.update(future="", agent="")
        printed = subprocess.run(
            [sys.executable, "-c", "import os; print(os.environ['HTTPS_PROXY'])"],
            capture_output=True,
            text=True,
            check=True,
            timeout=60,
        ).stdout.strip()
        check(
            "a child started outside a future keeps its environment",
            printed == os.environ["HTTPS_PROXY"],
            printed,
        )
    finally:
        subprocess.Popen.__init__ = original_init


def check_foreign_proxy_credentials():
    """Call through the proxy with credentials that name no future: the proxy takes no
    future from them, and drops them before the call goes on."""
    created.append("alice")  # so a record wrongly made for it is deleted at the end
    proxy = os.environ["HTTP_PROXY"].replace("http://", "http://alice:x@", 1)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({"http": proxy}))
    before = len(seen_headers)
    opener.open(
        urllib.request.Request(
            FAKE_URL + "/v1/chat/completions",
            data=json.dumps({"model": "fake-model", "messages": []}).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        ),
        timeout=30,
    ).read()
    got = seen_headers[before:]
    check(
        "proxy credentials that name no future never reach the provider",
        len(got) == 1 and "proxy-authorization" not in got[0],
        got,
    )
    check(
        "proxy credentials that name no future record nothing",
        tokens("alice") is None and not REDIS.exists("future:alice"),
    )


def check_future_route():
    """Call the gateway under /future/<id>/<agent>/, as a child's Bedrock endpoint does,
    and check the call is recorded on the future the path names."""
    name = "a call under /future/<id>/<agent>/ is recorded on that future"
    future = new_real_future()
    agent = os.environ["CANYONOS_AGENT_NAME"]
    try:
        urllib.request.urlopen(
            urllib.request.Request(
                f"{GATEWAY}/future/{future}/{agent}/openai/v1/chat/completions",
                data=json.dumps({"model": "fake-model", "messages": []}).encode(),
                headers={
                    "Content-Type": "application/json",
                    "x-canyonos-upstream": FAKE_URL,
                },
                method="POST",
            ),
            timeout=30,
        ).read()
    except urllib.error.HTTPError as error:
        check(name, False, f"{error.code} {error.read()[:200]!r}")
    check(name, tokens(future) == (3, 5), tokens(future))


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


# The image's own Redis rules: the password and, on Docker, TLS with this replica's
# certificate, which it also exports for the gateway check below.
sys.path.insert(0, "/app")
from redis_client import connection_options  # noqa: E402

REDIS = redis.Redis(
    host=os.environ["CANYONOS_REDIS_HOST"],
    port=int(os.environ["CANYONOS_REDIS_PORT"]),
    decode_responses=True,
    **connection_options(),
)


def main():
    """Run every check in order; the first that fails exits 1."""
    threading.Thread(
        target=ThreadingHTTPServer(("0.0.0.0", FAKE_PORT), FakeProvider).serve_forever,
        daemon=True,
    ).start()

    future = new_future()
    post("/v1/chat/completions", {"model": "fake-model", "messages": []}, future).read()
    check(
        "the gateway forwards the call to its provider",
        [path for path, _ in seen] == ["/v1/chat/completions"],
        seen,
    )
    check(
        "an OpenAI-format call reaches the gateway",
        tokens(future) == (3, 5),
        tokens(future),
    )

    future = new_future()
    arrivals, lines = [], []
    with post(
        "/v1/chat/completions", {"model": "fake-model", "stream": True}, future
    ) as response:
        for line in response:
            if line.startswith(b"data: {"):
                arrivals.append(time.monotonic())
                lines.append(line)
    check("every chunk of the stream is relayed", len(arrivals) == len(WORDS), lines)
    check(
        "a stream arrives chunk by chunk", arrivals[-1] - arrivals[0] >= 1.5, arrivals
    )
    check(
        "the gateway asked for usage",
        seen[-1][1].get("stream_options", {}).get("include_usage") is True,
    )
    check(
        "the usage chunk is not relayed", not any(b'"usage"' in line for line in lines)
    )
    check("the stream's tokens are recorded", tokens(future) == (3, 5), tokens(future))

    future = new_future()
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

    check_child_processes()
    check_foreign_proxy_credentials()
    check_future_route()

    future = new_future()
    post("/v3/collectors/1/responses", {"answers": []}, future).read()
    check(
        "a non-LLM POST reaches its host", seen[-1][0] == "/v3/collectors/1/responses"
    )
    check(
        "a non-LLM POST skips the gateway",
        tokens(future) is None and not REDIS.exists(f"future:{future}"),
    )

    prices = subprocess.run(
        [
            GATEWAY_PYTHON,
            "-c",
            "import json, os, redis; from canyonos_core.llm_gateway import pricing; "
            "from redis_client import connection_options; "
            "r = redis.Redis(host=os.environ['CANYONOS_REDIS_HOST'], "
            "port=int(os.environ['CANYONOS_REDIS_PORT']), decode_responses=True, "
            "**connection_options()); "
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

    check_llm_policy()

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
    future = new_future()
    post("/v1/chat/completions", {"model": "fake-model", "messages": []}, future).read()
    check(
        "a call reaches the restarted gateway", tokens(future) == (3, 5), tokens(future)
    )


if __name__ == "__main__":
    try:
        main()
    finally:
        if created:
            REDIS.delete(*(f"future:{future}" for future in created))
