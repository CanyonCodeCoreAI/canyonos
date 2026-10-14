# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
Shared request helpers for the Global Controller container, so the commands
that talk to it don't each restate the same routes, payloads and failure modes.
"""

import json
import urllib.error
import urllib.request

from canyonos import project, ui
from canyonos.init import load_state

REQUEST_TIMEOUT_SECONDS = 60


class GCError(RuntimeError):
    """A failed Global Controller request, carrying a message fit to print."""

    def __init__(self, message, code=None):
        super().__init__(message)
        self.code = code


def _error_detail(e):
    """The server's `error` field, falling back to the raw body when it isn't JSON."""
    body = e.read().decode(errors="replace").strip()
    try:
        parsed = json.loads(body)
    except ValueError:
        return body or f"HTTP {e.code}"
    if isinstance(parsed, dict):
        return parsed.get("error") or body or f"HTTP {e.code}"
    return body or f"HTTP {e.code}"


def _request(url, action, data=None, method="GET", timeout=REQUEST_TIMEOUT_SECONDS):
    """Call the Global Controller container's HTTP API and return its JSON reply; any
    failure is raised as `GCError`."""
    headers = {"Content-Type": "application/json"} if data is not None else {}
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read()
        try:
            parsed = json.loads(body)
        except (TypeError, ValueError):
            raise GCError(
                f"{action} failed: Global Controller returned invalid JSON"
            ) from None
        if not isinstance(parsed, dict):
            raise GCError(
                f"{action} failed: Global Controller returned an invalid response"
            )
        return parsed
    except urllib.error.HTTPError as e:
        raise GCError(f"{action} failed: {_error_detail(e)}", code=e.code) from None
    except urllib.error.URLError as e:
        raise GCError(
            f"Could not reach Global Controller container: {e.reason}"
        ) from None
    except (TimeoutError, OSError) as e:
        raise GCError(f"Could not reach Global Controller container: {e}") from None


def require_state():
    """Recorded container state, or None after reporting that there is none."""
    try:
        return load_state()
    except FileNotFoundError:
        ui.warn(
            "No Global Controller container is running. Run `canyonos deploy` first."
        )
        return None


def post_deploy(port, config_path=None):
    """Start a deploy inside the container. Raises GCError on failure.

    Omitting config_path lets canyonos resolve it against the synced workspace.
    """
    payload = {"project_name": project.folder_name()}
    if config_path:
        payload["config_path"] = config_path
    body = json.dumps(payload).encode()
    return _request(
        f"http://127.0.0.1:{port}/deploy", "Deploy", data=body, method="POST"
    )


def post_clean(port):
    """Tear down the running deploy: SIGTERMs the in-container `canyonos deploy`
    process, whose handler calls GlobalController.stop() and blocks until it
    returns. This is what actually removes the local controller and Redis
    containers a deploy spawned via docker-outside-of-docker.
    """
    return _request(f"http://127.0.0.1:{port}/clean", "Stop", method="POST")


def deploy_status(port):
    """Parsed /status payload, or None when the container can't be read.

    A malformed body is as uninformative as an unreachable one, so both answer
    None rather than raising at a caller whose contract is "couldn't tell".
    """
    url = f"http://127.0.0.1:{port}/status"
    try:
        with urllib.request.urlopen(url, timeout=5) as resp:
            status = json.loads(resp.read())
    except (OSError, ValueError, TypeError):
        return None
    return status if isinstance(status, dict) else None


def deployed_endpoint(port):
    """Return the endpoint record the running deploy published (`public_host`,
    `api_port`, `url`, `agent`, `method`, `arguments`) from GET /endpoint; raise
    GCError when the container can't say, including when no deploy is running."""
    return _request(f"http://127.0.0.1:{port}/endpoint", "Read endpoint", timeout=10)[
        "endpoint"
    ]
