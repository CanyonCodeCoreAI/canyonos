# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""The proxy every HTTP(S) call in an agent container leaves through: mitmproxy, run inside
the gateway's process. It decrypts only calls to known LLM hosts and sends their
OpenAI-format and Anthropic calls to the gateway, which forwards them to the host they were
addressed to. Every other call passes through untouched."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import threading

from canyonos_core.llm_gateway.hooks import (
    GATEWAY_HOST,
    LLM_PATHS,
    PROXY_CA_BUNDLE,
    PROXY_PORT,
    UPSTREAM_HEADER,
)
from canyonos_core.llm_gateway.pricing import llm_host


def _llm_provider(req):
    """The provider whose LLM-call path a POST goes to, or None for any other request."""
    if req.method != "POST":
        return None
    path = req.path.partition("?")[0]
    return next((name for name, p in LLM_PATHS.items() if p.search(path)), None)


class LlmCalls:
    """mitmproxy addon that sends LLM calls to the gateway."""

    def __init__(self):
        self.listening = threading.Event()

    def running(self):
        """mitmproxy is listening; it exits without getting here if it cannot bind its port."""
        self.listening.set()

    def tls_clienthello(self, data):
        """Pass a connection to any other host through still encrypted, so its client keeps
        its own TLS: fingerprint, pinned certificate, client certificate."""
        data.ignore_connection = llm_host(data.client_hello.sni) is None

    def requestheaders(self, flow):
        """Stream every request body except a possible LLM call's, which `request` reads."""
        flow.request.stream = _llm_provider(flow.request) is None

    def request(self, flow):
        """Send a call whose JSON body names a model to the gateway under its provider's
        prefix; another API's POST to a path like /responses names none."""
        req = flow.request
        provider = _llm_provider(req)
        if provider is None:
            return
        try:
            model = json.loads(req.content).get("model")
        except Exception:
            return
        if isinstance(model, str):
            req.headers[UPSTREAM_HEADER] = (
                f"{req.scheme}://{req.pretty_host}:{req.port}"
            )
            req.url = f"{GATEWAY_HOST}/{provider}{req.path}"

    def responseheaders(self, flow):
        """Relay every response as it arrives, so streamed LLM output is not held back."""
        flow.response.stream = True


def start() -> None:
    """Run mitmproxy on PROXY_PORT in a background thread, then write PROXY_CA_BUNDLE so the
    container's clients trust the certificates it presents. Raises if it does not come up."""
    import certifi
    from mitmproxy.options import Options  # ty: ignore[unresolved-import]
    from mitmproxy.tools.dump import DumpMaster  # ty: ignore[unresolved-import]

    confdir = os.path.dirname(PROXY_CA_BUNDLE)
    logging.getLogger("mitmproxy").setLevel(logging.WARNING)
    addon = LlmCalls()

    async def run():
        master = DumpMaster(Options(), with_termlog=False, with_dumper=False)
        master.options.update(
            listen_host="127.0.0.1",
            listen_port=PROXY_PORT,
            confdir=confdir,
            connection_strategy="lazy",
        )
        master.addons.add(addon)
        await master.run()

    threading.Thread(
        target=asyncio.run, args=(run(),), name="llm-proxy", daemon=True
    ).start()
    if not addon.listening.wait(30):
        raise RuntimeError(f"LLM proxy did not listen on port {PROXY_PORT}")
    with (
        open(certifi.where()) as roots,
        open(os.path.join(confdir, "mitmproxy-ca-cert.pem")) as ca,
        open(PROXY_CA_BUNDLE, "w") as bundle,
    ):
        bundle.write(roots.read() + ca.read())
