# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
Logic for `canyonos dashboard`: open the dashboard running on this machine, signed in.
With an API key here, it hands the key to the sign-in screen in the URL's fragment,
which the browser never sends to a server; the screen stores it and strips it. A
dashboard that checks no key just opens.
"""

import json
import sys
import urllib.request
import webbrowser
from urllib.parse import quote

from canyonos import ui
from canyonos.auth import machine_api_key
from canyonos.dashboard_stack import (
    SERVICE_PORTS,
    _existing_dashboard_port,
    _published_port,
    dashboard_url,
)
from canyonos.os_support import is_terminal


def _requires_key():
    """False when the dashboard's API answers that it checks no API key; True
    otherwise, also when it can't say."""
    port = _published_port("api", SERVICE_PORTS["api"][0])
    if port is None:
        return True
    try:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{port}/auth/status", timeout=5
        ) as response:
            return (
                json.loads(response.read()).get("api_key_required", True) is not False
            )
    except (OSError, ValueError, AttributeError):
        return True


def _open(url, shown):
    """Open `url` in the browser from a terminal, saying `shown` instead of it; print
    `url` alone on stdout when there is no terminal or no browser. Returns whether it
    opened."""
    if is_terminal(sys.stdout) and webbrowser.open(url):
        ui.ok(f"Opened the dashboard: {shown}")
        return True
    ui.result(url)
    return False


def run_open_dashboard():
    """Run `canyonos dashboard`: open the dashboard on this machine signed in with
    this machine's API key, or show its URL and how to sign in when there is no key
    here. Returns False when no dashboard runs."""
    port = _existing_dashboard_port()
    if port is None:
        ui.fail(
            "The dashboard is not running. Start it with `canyonos serve`, or deploy "
            "with `canyonos deploy`."
        )
        return False
    url = dashboard_url(port)
    key = machine_api_key()
    if not _requires_key():
        with ui.to_stderr():
            _open(url, url)
        return True
    if key is None:
        with ui.to_stderr():
            _open(url, url)
            ui.say(
                "No API key is set here, so sign in with the key the dashboard was "
                "started with, or restart it with one: canyonos serve --api-key <key>"
            )
        return True
    with ui.to_stderr():
        opened = _open(f"{url}/login#key={quote(key, safe='')}", url)
        ui.hint("Signed in with this machine's API key.")
        if not opened:
            ui.hint(
                "The link above holds the API key and signs in whoever opens it: keep "
                "it like a password."
            )
    return True
