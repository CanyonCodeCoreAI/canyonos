# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""HTTP health endpoints for a CanyonOS pod (a replica or the Global Controller), so
Kubernetes can probe it: /startupz (finished starting), /readyz (should get traffic) and
/livez (not stuck).

Off unless CANYONOS_HEALTH_PORT is set; Docker and EC2 read a replica's status from
Redis instead. Each path answers 200 or 503 from a check the caller passes in.
Checks look only at the process's own state, never at Redis: a Redis outage must not
de-route or restart every replica at once. The server runs on its own threads, apart
from the gRPC server, so probes never queue behind real calls.
"""

import logging
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

logger = logging.getLogger(__name__)

PORT_ENV = "CANYONOS_HEALTH_PORT"


class _Handler(BaseHTTPRequestHandler):
    # Set on the subclass start_health_server makes for its checks.
    checks = {}

    def do_GET(self):
        check = self.checks.get(self.path)
        if check is None:
            self._reply(404, "unknown health check")
            return
        try:
            healthy, reason = check()
        except Exception as e:
            healthy, reason = False, f"check failed: {e}"
        self._reply(200 if healthy else 503, reason)

    def _reply(self, status, body):
        payload = f"{body}\n".encode()
        try:
            self.send_response(status)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            # The prober gave up (its timeout) and hung up: nothing to answer, and no
            # traceback for each timed-out probe.
            pass

    def log_message(self, format, *args):
        # A probe every few seconds would bury the replica's own logs.
        pass


def start_health_server(checks, port=None):
    """Serve `checks`, a {path: callable returning (healthy, reason)} map, on every
    interface in a daemon thread. Returns the server, or None when no port is set.

    Raises RuntimeError when the port is not a number or cannot be served: without the
    server the pod could never pass its probes, so it fails at once with the reason."""
    port = port if port is not None else os.environ.get(PORT_ENV)
    if port in (None, ""):
        return None
    handler = type("_HealthHandler", (_Handler,), {"checks": checks})
    try:
        # Every interface: the kubelet probes the pod's own IP.
        server = ThreadingHTTPServer(("0.0.0.0", int(port)), handler)
    except (ValueError, OSError) as e:
        raise RuntimeError(
            f"Could not serve health checks on {PORT_ENV}={port!r}: {e}"
        ) from e
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, name="health", daemon=True).start()
    logger.info("Health checks served on port %d.", server.server_address[1])
    return server


def stop_health_server(server):
    """Stop a server start_health_server returned and release its port; None is fine."""
    if server is None:
        return
    server.shutdown()
    server.server_close()
