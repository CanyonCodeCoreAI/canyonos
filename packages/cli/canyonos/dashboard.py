# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
Logic for `canyonos dashboard`: open the dashboard running on this machine, signed in
with the API key of the workflow group this command acts on, which shows that workflow
group's workflows and those of every workflow group without a key. It hands the key to
the sign-in screen in the URL's fragment, which the browser never sends to a server;
the screen stores it and strips it. A dashboard that checks no key just opens.
"""

import json
import sys
import urllib.request
import webbrowser
from urllib.parse import quote

from canyonos import ui
from canyonos.auth import group_api_key
from canyonos.dashboard_stack import dashboard_url, running_api_port, running_web_port
from canyonos.deployment import configured_target
from canyonos.os_support import is_terminal


def _requires_key(api_url):
    """False when the dashboard's API at `api_url` answers that it checks no API key;
    True otherwise, also when it can't say or there is none."""
    if api_url is None:
        return True
    try:
        with urllib.request.urlopen(f"{api_url}/v1/auth/status", timeout=5) as response:
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
    the API key of the workflow group this command acts on, or show its URL and how to
    sign in when it has no key. On Kubernetes it is the cluster's dashboard, forwarded
    to this machine as `canyonos serve` does. Returns False when no dashboard runs."""
    if configured_target() == "kubernetes":
        # Imported here: Docker's dashboard needs none of the cluster's modules.
        from canyonos.kubernetes_target import _open_dashboard

        url, api_url = f"http://127.0.0.1:{_open_dashboard()}", None
    else:
        port = running_web_port()
        if port is None:
            ui.fail(
                "The dashboard is not running. Start it with `canyonos serve`, or deploy "
                "with `canyonos deploy`."
            )
            return False
        url = dashboard_url(port)
        api_port = running_api_port()
        api_url = f"http://127.0.0.1:{api_port}" if api_port else None
    key = group_api_key()
    if not _requires_key(api_url):
        with ui.to_stderr():
            _open(url, url)
        return True
    if key is None:
        with ui.to_stderr():
            _open(url, url)
            ui.say(
                "This workflow group has no API key, so sign in with the key of the "
                "workflow group to see: `canyonos deploy --api-key <key>` sets one"
            )
        return True
    with ui.to_stderr():
        opened = _open(f"{url}/login#key={quote(key, safe='')}", url)
        ui.hint("Signed in with this workflow group's API key.")
        if not opened:
            ui.hint(
                "The link above holds the API key and signs in whoever opens it: keep "
                "it like a password."
            )
    return True
