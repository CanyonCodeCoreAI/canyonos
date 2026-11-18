# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
Logic for `canyonos dashboard`: open the dashboard running on this machine, signed in.
With a private key here, it signs a read and a write token valid for
SIGN_IN_TTL_SECONDS and hands them to the sign-in screen in the URL's fragment, which
the browser never sends to a server; the screen stores them and strips it. Without a
key it shows the URL and how to make tokens; a dashboard that checks no token just
opens.
"""

import json
import sys
import urllib.request
import webbrowser
from urllib.parse import urlencode

from canyonos import ui
from canyonos.auth import api_token, signing_keys
from canyonos.dashboard_stack import (
    SERVICE_PORTS,
    _existing_dashboard_port,
    _published_port,
    dashboard_url,
)
from canyonos.os_support import is_terminal

SIGN_IN_TTL_SECONDS = 8 * 60 * 60


def _checks_tokens():
    """False when the dashboard's API answers that it verifies no token
    (`--dangerous-skip-auth`); True otherwise, also when it can't say."""
    port = _published_port("api", SERVICE_PORTS["api"][0])
    if port is None:
        return True
    try:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{port}/auth/status", timeout=5
        ) as response:
            return not json.loads(response.read()).get("disabled", False)
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


def run_open_dashboard(key=None, auth_dir=None):
    """Run `canyonos dashboard`: open the dashboard on this machine signed in with a
    read and a write token signed by the private key `key` (or the only one) in
    `auth_dir`, or show its URL and how to sign in when there is no key. Returns False
    when no dashboard runs."""
    port = _existing_dashboard_port()
    if port is None:
        ui.fail(
            "The dashboard is not running. Start it with `canyonos serve`, or deploy "
            "with `canyonos deploy`."
        )
        return False
    url = dashboard_url(port)
    if not _checks_tokens():
        with ui.to_stderr():
            _open(url, url)
        return True
    if key is None and not signing_keys(auth_dir):
        with ui.to_stderr():
            _open(url, url)
            ui.say(
                "No private key here signs tokens, so sign in with tokens made where "
                "the key is, or make a key here, restart the dashboard and make them:"
            )
            ui.command("canyonos keys create && canyonos serve")
            ui.command("canyonos token create --scope read")
            ui.command("canyonos token create --scope write")
        return True
    tokens = {
        scope: api_token(scope, SIGN_IN_TTL_SECONDS, key, auth_dir)
        for scope in ("read", "write")
    }
    with ui.to_stderr():
        opened = _open(f"{url}/login#{urlencode(tokens)}", url)
        hours = SIGN_IN_TTL_SECONDS // 3600
        ui.hint(f"Signed in with a read and a write token valid for {hours} hours.")
        if not opened:
            ui.hint(
                "The link above signs in whoever opens it until then: keep it like a "
                "password."
            )
    return True
