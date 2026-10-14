# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Tell the local dashboard api which Redis port a project's controller uses.

Temporary: applied now so multi-project dashboards work without blocking the flow;
revisit with the project-key design in CAN-521 (the api should not hold
per-project Redis addresses).
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request

API_PORT = 3000
ATTEMPTS = 3
RETRY_DELAY_SECONDS = 1
TIMEOUT_SECONDS = 10


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


def _post(url: str, payload: bytes) -> dict:
    request = urllib.request.Request(
        url,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
        registered = json.loads(response.read())
    if not isinstance(registered, dict):
        raise RegistrationError("the dashboard api answered with an unexpected body")
    return registered


def register_project(redis_port: int, api_port: int = API_PORT) -> dict:
    """Register the project whose controller writes to Redis on `redis_port`.

    Returns the api's `{project_id, name}`. Connection failures and 5xx answers
    are retried, up to ATTEMPTS in all; a 4xx answer is final. Raises
    RegistrationError carrying the api's message when registration fails.
    """
    url = f"http://127.0.0.1:{api_port}/canyonos/projects"
    payload = json.dumps({"redis_port": redis_port}).encode()
    failure = "the dashboard api did not answer"
    for attempt in range(ATTEMPTS):
        if attempt:
            time.sleep(RETRY_DELAY_SECONDS)
        try:
            return _post(url, payload)
        except urllib.error.HTTPError as e:
            failure = _error_message(e)
            if e.code < 500:
                break
        except (OSError, ValueError) as e:
            failure = f"the dashboard api did not answer: {e}"
    raise RegistrationError(failure)
