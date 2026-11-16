# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Tell the local dashboard api which Redis a deployment's controller uses: its
container and port, on the deployment's network the dashboard joins first, and its
password.

Temporary: applied now so a dashboard of several deployments works without blocking
the flow; revisit with the project-key design in CAN-521 (the api should not hold
per-deployment Redis addresses).
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request

from canyonos import deployment
from canyonos.dashboard_stack import join_deployment_network

# How long a registration the api refuses with a 5xx is tried again. Just after a
# redeploy, the api can keep reaching for the deployment's old Redis, which had the
# same name, for up to about half a minute.
RETRY_SECONDS = 60
RETRY_DELAY_SECONDS = 2
TIMEOUT_SECONDS = 10
# Replaying a recorded week writes tens of thousands of rows; seconds on a fast
# machine, longer on a slow one under Docker.
SAMPLE_DATA_TIMEOUT_SECONDS = 60


class RegistrationError(Exception):
    """Raised when the dashboard api does not register the project."""


def _error_message(error: urllib.error.HTTPError) -> str:
    """The api's error message from its `{error, message}` envelope, else the HTTP status."""
    try:
        body = json.loads(error.read())
    except (OSError, ValueError):
        body = None
    if isinstance(body, dict) and isinstance(body.get("message"), str):
        return body["message"]
    return f"the dashboard api answered HTTP {error.code}"


def _post(url: str, payload: bytes, timeout: float = TIMEOUT_SECONDS) -> dict:
    request = urllib.request.Request(
        url,
        data=payload,
        headers={"Content-Type": "application/json"},
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


def register_project(redis_port: int, api_port: int | None = None) -> dict:
    """Connect the dashboard api to the deployment's network, then register the
    project with its Redis container's name, `redis_port` and the deployment's Redis
    password, with the dashboard's API on `api_port`, or where it is when that is
    None.

    Returns the api's `{project_id, name}`. Connection failures and 5xx answers
    are retried for up to RETRY_SECONDS; a 4xx answer is final. Raises
    RegistrationError carrying Docker's or the api's message when joining the
    network or registration fails.
    """
    url = f"http://127.0.0.1:{api_port or _api_port()}/canyonos/projects"
    joined = join_deployment_network(deployment.deployment_group())
    if joined is not None:
        raise RegistrationError(joined)
    payload = json.dumps(
        {
            "redis_host": deployment.redis_container_name(),
            "redis_port": redis_port,
            "redis_password": deployment.redis_password(),
        }
    ).encode()
    failure = "the dashboard api did not answer"
    deadline = time.monotonic() + RETRY_SECONDS
    while True:
        try:
            return _post(url, payload)
        except urllib.error.HTTPError as e:
            failure = _error_message(e)
            if e.code < 500:
                break
        except (OSError, ValueError) as e:
            failure = f"the dashboard api did not answer: {e}"
        if time.monotonic() > deadline:
            break
        time.sleep(RETRY_DELAY_SECONDS)
    raise RegistrationError(failure)


def add_sample_data(
    project_id: str, workflow: str, api_port: int | None = None
) -> dict:
    """Ask the dashboard, its API on `api_port` or where it is when that is None, to
    add its recorded run of `workflow` to this project.

    The api replays a run of that bundled workflow it ships, spread across the
    week ending now, so a first request lands among a week of earlier ones
    instead of alone. The body names a workflow, never data: the only data the
    api can write here is its own.

    Returns the api's `{spans, logs, metrics}`. Raises RegistrationError with
    the api's message when it does not answer.
    """
    url = (
        f"http://127.0.0.1:{api_port or _api_port()}/projects/{project_id}/sample-data"
    )
    payload = json.dumps({"workflow": workflow}).encode()
    try:
        return _post(url, payload, SAMPLE_DATA_TIMEOUT_SECONDS)
    except urllib.error.HTTPError as e:
        raise RegistrationError(_error_message(e)) from None
    except (OSError, ValueError) as e:
        raise RegistrationError(f"the dashboard api did not answer: {e}") from None
