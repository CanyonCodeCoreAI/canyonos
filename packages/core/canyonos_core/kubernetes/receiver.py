# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Take a project's upload in an in-cluster build pod.

`canyonos deploy --target kubernetes` sends the project (its `.canyon` folder and config) as a
gzipped tar by HTTP PUT through a port-forward to the build pod; this unpacks it and
lets the build start. A port-forward needs only `pods/portforward`, not `pods/exec`.
"""

import io
import logging
import os
import tarfile
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

logger = logging.getLogger(__name__)

# The largest upload taken: a project is code and config, not data.
MAX_UPLOAD_BYTES = 512 * 1024 * 1024
# Written into the destination once the project is unpacked: the build container,
# running beside this one, starts when it appears. (A port-forward reaches only a
# running pod, so the receiver cannot be an init container.)
RECEIVED_MARKER = ".canyonos-received"


def unpack(archive, dest):
    """Unpack a gzipped tar into dest, refusing anything that would land outside it
    (absolute paths, `..`, links out) and keeping no owner from the sender."""
    # The "data" filter is that refusal (tarfile, Python 3.11.4+; the core image runs
    # 3.11), which the rule does not recognise; the tests upload a `../` entry.
    # nosemgrep: trailofbits.python.tarfile-extractall-traversal.tarfile-extractall-traversal
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tar:
        tar.extractall(dest, filter="data")


def receive_upload(dest, port, timeout):
    """Serve PUT / on port until one valid upload is unpacked into dest; True then,
    False when none arrives within timeout seconds."""
    os.makedirs(dest, exist_ok=True)
    done = threading.Event()

    class Handler(BaseHTTPRequestHandler):
        def do_PUT(self):
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0:
                self.send_error(400, "the upload is empty")
                return
            if length > MAX_UPLOAD_BYTES:
                self.send_error(413, "the upload is too large")
                return
            try:
                unpack(self.rfile.read(length), dest)
            except (tarfile.TarError, OSError) as error:
                logger.error("Upload rejected: %s", error)
                self.send_error(400, f"not a usable project archive: {error}")
                return
            with open(os.path.join(dest, RECEIVED_MARKER), "w") as marker:
                marker.write("1")
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"received\n")
            done.set()

        def log_message(self, format, *args):  # noqa: A002 (the base class names it)
            logger.info("upload: " + format, *args)

    # Loopback only: `kubectl port-forward` connects to the pod's own localhost, so the
    # CLI's upload arrives, and no other pod in the cluster can send a project here.
    server = HTTPServer(("127.0.0.1", port), Handler)
    server.timeout = 1
    logger.info("Waiting for the project upload on port %d", port)
    # A clock, not a count of requests: each rejected upload returns at once.
    deadline = time.monotonic() + timeout
    while not done.is_set() and time.monotonic() < deadline:
        server.handle_request()
    server.server_close()
    if done.is_set():
        logger.info("Project received into %s", dest)
        return True
    logger.error("No project upload within %d seconds", timeout)
    return False
