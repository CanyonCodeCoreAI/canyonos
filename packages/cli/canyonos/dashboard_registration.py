# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Register a workflow group with the local dashboard as its Global Controller is
created: join the dashboard to the workflow group's network, then have the CanyonOS API
store each workflow's name and the Redis the Global Controller uses, which the
dashboard reaches by name on that network.

`canyonos deploy` stops when it fails: the status and `canyonos curl` read the workflow
group's Redis through it. Temporary: revisit with the workflow-key design in CAN-521 (the
api should not hold per-deployment Redis addresses).
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request

from canyonos import deployment, internal_ca
from canyonos.auth import auth_header
from canyonos.api import ApiError, put_dashboard
from canyonos.dashboard_stack import join_deployment_network
from canyonos.init import controller_redis

# How long a registration the API refuses with a 5xx, or doesn't answer, is tried
# again: an API that just started answers 503 until its database is ready.
RETRY_SECONDS = 60
RETRY_DELAY_SECONDS = 2
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


def _registration(state: dict) -> dict:
    """What the dashboard stores for the workflow group `state` records: each workflow's
    name by its workflow_id, and the Redis its Global Controller was created for, with
    a client certificate its CA signs when that Redis takes only TLS."""
    return {
        "workflows": deployment.workflow_names_by_id(),
        **controller_redis(state),
        "redis_tls": internal_ca.client_certificate("dashboard"),
    }


def register_workflows(state: dict) -> list[dict]:
    """Connect the dashboard's API to the network of the workflow group `state`
    records, where it reaches the workflow group's Redis by name, then register the
    workflow group with it. Its Global Controller need not run. An API that doesn't
    answer or answers with a 5xx is asked again for up to RETRY_SECONDS; a 4xx answer
    is final. Returns the dashboard's `{workflow_id, name}` of each workflow; raises
    RegistrationError with Docker's or the API's message."""
    joined = join_deployment_network(deployment.deployment_group())
    if joined is not None:
        raise RegistrationError(joined)
    try:
        registration = _registration(state)
    except RuntimeError as e:
        raise RegistrationError(str(e)) from None
    deadline = time.monotonic() + RETRY_SECONDS
    while True:
        try:
            return put_dashboard(state, registration)["workflows"]
        except ApiError as e:
            final = e.status is not None and e.status < 500
            if final or time.monotonic() > deadline:
                raise RegistrationError(str(e)) from None
        time.sleep(RETRY_DELAY_SECONDS)


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
