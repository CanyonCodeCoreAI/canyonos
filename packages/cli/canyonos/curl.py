# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
Logic for `canyonos curl`: POST one JSON body to a workflow of the running workflow group,
this folder's or the selected one, with this machine's API key, and print what the
endpoint answers. It sends that one request and waits for nothing else: the answer to
a queued request is its `request_id`, whose result `/status/<request_id>` gives.
"""

import json
import os
import sys
import urllib.error
import urllib.request
from urllib.parse import urlsplit

from canyonos import ui
from canyonos.auth import auth_header, machine_api_key
from canyonos.constants import deployment_config_path
from canyonos.deploy import _curl_example
from canyonos.api import deployed_endpoint, existing_deploy
from canyonos.os_support import is_terminal
from utils import tui

REQUEST_TIMEOUT_SECONDS = 30


def _route_path(route):
    """The route as `<workflow>/<agent>/<method>`."""
    return f"{route['workflow']}/{route['agent']}/{route['method']}"


def _named(routes, wanted):
    """The routes `wanted` names: its URL, `<workflow>/<agent>/<method>`,
    `<agent>/<method>` or `<method>`."""
    if wanted.startswith(("http://", "https://")):
        path = urlsplit(wanted).path
        return [r for r in routes if urlsplit(r["url"]).path == path]
    parts = wanted.strip("/").split("/")
    return [r for r in routes if _route_path(r).split("/")[-len(parts) :] == parts]


def _listed(routes):
    """The routes as `<workflow>/<agent>/<method>`, comma-separated."""
    return ", ".join(_route_path(route) for route in routes)


def _pick_route(routes, wanted):
    """The route to call: the one `wanted` names, the only one, or the one picked from
    a menu in a terminal; None after saying why when there is none to call."""
    if wanted:
        named = _named(routes, wanted)
        if len(named) == 1:
            return named[0]
        if named:
            ui.fail(f"--route {wanted} names several routes: {_listed(named)}")
        else:
            ui.fail(f"--route {wanted} names no route; there are: {_listed(routes)}")
        return None
    if len(routes) == 1:
        return routes[0]
    if not routes:
        ui.fail("The running workflow group serves no route.")
        return None
    if not is_terminal(sys.stdin):
        ui.fail(
            "This workflow group serves several routes; pick one with --route: "
            + _listed(routes)
        )
        return None
    options = [(route, _route_path(route)) for route in routes]
    picked = tui.select_menu(options, "Send to")
    if picked is None:
        ui.fail("No route picked.")
    return picked


def _send(url, body, key):
    """POST `body` to `url` with `key`, if any, and return the status code and the
    body the endpoint answered with."""
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", **auth_header(key)},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as answer:
            return answer.status, answer.read().decode(errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="replace")
    except OSError as e:
        raise RuntimeError(f"Could not reach the workflow at {url}: {e}") from None


def _show(text):
    """Print the endpoint's answer on stdout, indented when it is JSON."""
    try:
        text = json.dumps(json.loads(text), indent=2)
    except ValueError:
        pass
    ui.result(text)


def run_curl(body_text, route=None, show_command=False):
    """Run `canyonos curl`: POST the JSON `body_text` to a route of the running
    workflow group, by default its only one, and print the answer; with `show_command`,
    print the equivalent `curl` instead, the key left out. Returns the exit code: 0
    when the endpoint answers 2xx."""
    try:
        body = json.loads(body_text)
    except ValueError as e:
        ui.fail(
            f"The body is not valid JSON ({e}). Quote it whole, for example: "
            """canyonos curl '{"query": "hello"}'"""
        )
        return 1
    if not os.path.isfile(deployment_config_path()):
        ui.fail(
            "No workflow group is selected. Run it from a workflow group's folder, or see "
            "the workflow groups with `canyonos list` and pick one with "
            "`canyonos select-context <workflow group>`."
        )
        return 1
    state = existing_deploy()
    if state is None:
        ui.fail("No workflow group is running. Start it with `canyonos deploy`.")
        return 1
    picked = _pick_route(deployed_endpoint(state)["routes"], route)
    if picked is None:
        return 1
    key = machine_api_key()
    if show_command:
        ui.result(_curl_example(picked["url"], body, key is not None))
        return 0
    status, answer = _send(picked["url"], body, key)
    _show(answer)
    if 200 <= status < 300:
        return 0
    ui.fail(f"The endpoint answered HTTP {status}.")
    return 1
