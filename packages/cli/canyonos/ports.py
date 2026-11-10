# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""The ports CanyonOS holds on this machine, and the one rule a command picks a port by.

A port the config sets (`endpoint.api_port`, `dashboard_port`, a forward's fixed
port) is used as it is, or refused when it is taken: what reads it back would
otherwise look for it where it isn't. Any other port starts at the one it had last
time, or its default, and moves to the next one that is free on every interface
(`port_utils.is_port_free`) and claimed by nothing else of CanyonOS here: another
deployed project's Global Controller, Redis or endpoint (its state.json), a running
port-forward (its record), or the dashboard. The Global Controller skips the same
ports when Docker makes it move one (`port_utils.RESERVED_PORTS_ENV`).

A command picks its ports and writes them down under `held()`, so two commands at
the same moment never pick the same one.
"""

import contextlib
import json
import os

from canyonos import project, ui
from canyonos.os_support import file_lock
from canyonos.port_utils import find_free_port

DASHBOARD = "the dashboard"


@contextlib.contextmanager
def held():
    """Hold the lock every command picks a port under, waiting for one that has it."""
    # Beside `projects/`, not in it: every entry there is read as a project.
    home = os.path.dirname(project.projects_dir())
    os.makedirs(home, exist_ok=True)
    lock = os.path.join(home, "ports.lock")
    with file_lock(lock, wait=True):
        yield


def claimed(dashboard_port=None, picking_dashboard=False):
    """The ports CanyonOS holds here or has picked to, each with what holds it: the
    dashboard's are the running one's, else the ones it starts on next
    (`dashboard_stack.service_ports`, with `dashboard_port`, the config's). When
    `picking_dashboard`, a dashboard's own ports are being picked, so only a
    dashboard already running holds them."""
    # Imported here: both pick their own ports through this module.
    from canyonos.dashboard_stack import _existing_dashboard_port, service_ports
    from canyonos.forwards import forward_port, running_forwards

    claims = {}
    with contextlib.suppress(OSError):
        for name in os.listdir(project.projects_dir()):
            with contextlib.suppress(OSError, ValueError):
                path = os.path.join(project.projects_dir(), name, "state.json")
                with open(path, encoding="utf-8") as f:
                    state = json.load(f)
                for key in ("port", "redis_port", "api_port"):
                    if isinstance(state.get(key), int):
                        claims[state[key]] = f"project {name}"
    for name in running_forwards():
        claims[forward_port(name)] = f"the port-forward {name}"
    if not picking_dashboard or _existing_dashboard_port():
        claims.update(dict.fromkeys(service_ports(dashboard_port).values(), DASHBOARD))
    return claims


def pick(preferred, what, claims):
    """The first port at or after `preferred` that is free and not in `claims`, with a
    warning naming where `what` went when that isn't `preferred` (none without
    `what`, for a caller that shows the port itself)."""
    port = find_free_port(preferred, skip=frozenset(claims))
    if port != preferred and what:
        why = "is the dashboard's" if claims.get(preferred) == DASHBOARD else "is taken"
        ui.warn(f"Port {preferred} {why}, so {what} is on {port}.")
    return port
