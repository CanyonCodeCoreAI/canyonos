# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Join the local dashboard to a workflow group's network and have the workflow group's
Global Controller tell the dashboard api which Redis it uses.

Temporary: applied now so a dashboard of several workflow groups works without blocking
the flow; revisit with the workflow-key design in CAN-521 (the api should not hold
per-deployment Redis addresses).
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request

from canyonos import deployment
from canyonos.auth import auth_header
from canyonos.dashboard_stack import (
    SERVICE_PORTS,
    _container_name,
    join_deployment_network,
)
from canyonos.gc import GCError, put_dashboard

TIMEOUT_SECONDS = 10
# Replaying a recorded week writes tens of thousands of rows; seconds on a fast
# machine, longer on a slow one under Docker.
SAMPLE_DATA_TIMEOUT_SECONDS = 60


class RegistrationError(Exception):
    """Raised when the dashboard api does not register the workflow group."""


def _error_message(error: urllib.error.HTTPError) -> str:
    """The api's error message from its `{error, message}` envelope, else the HTTP status."""
    try:
        body = json.loads(error.read())
    except (OSError, ValueError):
        body = None
    if isinstance(body, dict) and isinstance(body.get("message"), str):
        return body["message"]
    return f"the dashboard api answered HTTP {error.code}"


def _post(
    url: str,
    payload: bytes,
    timeout: float = TIMEOUT_SECONDS,
) -> dict:
    request = urllib.request.Request(
        url,
        data=payload,
        headers={"Content-Type": "application/json", **auth_header()},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        registered = json.loads(response.read())
    if not isinstance(registered, dict):
        raise RegistrationError("the dashboard api answered with an unexpected body")
    return registered


def _api_port() -> int:
    """The host port the dashboard's API is on."""
    # Imported here: the dashboard's stack reads ports this module has no need of.
    from canyonos.dashboard_stack import service_ports

    return service_ports()["api"]


def register_workflows(state: dict) -> list[dict]:
    """Connect the dashboard api to the workflow group's network, then have the Global
    Controller `state` records register the workflow group's workflows. Returns the api's
    `{workflow_id, name}` of each workflow; raises RegistrationError with Docker's or the
    controller's message."""
    joined = join_deployment_network(deployment.deployment_group())
    if joined is not None:
        raise RegistrationError(joined)
    try:
        return put_dashboard(
            state, f"http://{_container_name('api')}:{SERVICE_PORTS['api'][0]}"
        )["workflows"]
    except GCError as e:
        raise RegistrationError(str(e)) from None


def add_sample_data(
    workflow_id: str,
    workflow: str,
    api_port: int | None = None,
) -> dict:
    """Ask the dashboard, its API on `api_port` or where it is when that is None, to
    add its recorded run of `workflow` to the workflow `workflow_id`.

    The api replays a run of that bundled workflow it ships, spread across the
    week ending now, so a first request lands among a week of earlier ones
    instead of alone. The body names a workflow, never data: the only data the
    api can write here is its own.

    The call sends this machine's API key, when one is set. Returns the api's
    `{spans, logs, metrics}`. Raises RegistrationError with the api's message when it
    does not answer.
    """
    base_url = f"http://127.0.0.1:{api_port or _api_port()}"
    url = f"{base_url}/workflows/{workflow_id}/sample-data"
    payload = json.dumps({"workflow": workflow}).encode()
    try:
        return _post(url, payload, SAMPLE_DATA_TIMEOUT_SECONDS)
    except urllib.error.HTTPError as e:
        raise RegistrationError(_error_message(e)) from None
    except (OSError, ValueError) as e:
        raise RegistrationError(f"the dashboard api did not answer: {e}") from None
