# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
Logic for `canyonos status`: reports whether a deploy is currently running,
and if so, where the workflow (and, if up, the dashboard) answer.
"""

import json

from canyonos import ui
from canyonos.dashboard_stack import _existing_dashboard_port, dashboard_url
from canyonos.deploy import summary_body
from canyonos.gc import (
    GCError,
    deploy_status,
    deployed_endpoint,
    require_state,
    runtime_status,
)


def run_status(as_json=False):
    """Run `canyonos status`: show in the terminal whether a deploy is running, where to
    reach it, and how to query it; with `as_json`, print that, the agents and machine
    errors as one JSON object instead. Returns True when a deploy is running."""
    ui.set_quiet(as_json)
    try:
        report = _report_status(as_json)
    finally:
        ui.set_quiet(False)
    if as_json:
        print(json.dumps(report, indent=2))
    return report["running"]


def _report_status(with_agents):
    """Show the status in the terminal and return it, with the agents and machine
    errors when asked, and why any part of it could not be read under `errors`."""
    report = {
        "running": False,
        "endpoint": None,
        "dashboard_url": None,
        "agents": None,
        "machine_errors": None,
        "errors": [],
    }
    state = require_state()
    if state is None:
        return report

    status = deploy_status(state["port"])
    if not status or not status.get("running"):
        ui.warn("No deploy is currently running.")
        return report

    report["running"] = True
    ui.ok("Deploy is running.")

    try:
        report["endpoint"] = deployed_endpoint(state["port"])
    except GCError as e:
        report["errors"].append(str(e))
        ui.warn(
            "Could not read the running deploy's endpoint. Run `canyonos logs` to see why."
        )
    if with_agents:
        try:
            report.update(runtime_status(state["port"]))
        except GCError as e:
            report["errors"].append(str(e))

    dashboard_port = _existing_dashboard_port()
    report["dashboard_url"] = dashboard_url(dashboard_port) if dashboard_port else None
    ui.blank()
    ui.panel(summary_body(report["dashboard_url"], report["endpoint"]))
    return report
