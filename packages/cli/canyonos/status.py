# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
Logic for `canyonos status`: reports whether a deploy is currently running,
and if so, where the workflow (and, if up, the dashboard) answer.
"""

import json

from canyonos import deployment, ui
from canyonos.dashboard_stack import _existing_dashboard_port, dashboard_url
from canyonos.deploy import summary_body
from canyonos.gc import GCError, NoDeployError, deploy_status, require_state


def run_status(as_json=False):
    """Run `canyonos status`: show in the terminal whether a deploy is running, where to
    reach it, how to query it, and each agent's last launch error; with `as_json`, print
    the Global Controller's whole status and where to reach it as one JSON object
    instead. Returns True when a deploy is running."""
    ui.set_quiet(as_json)
    try:
        report = _report_status()
    finally:
        ui.set_quiet(False)
    if as_json:
        print(json.dumps(report, indent=2))
    return report["running"]


def _report_status():
    """Show the status in the terminal and return it: the Global Controller's
    status, with why any part of it could not be read under `errors`, plus the
    target, the workflow group and where the controller and the dashboard answer."""
    report = {
        "running": False,
        "target": deployment.configured_target(),
        "workflow_group": deployment.deployment_name(),
        "controller_url": None,
        "endpoint": None,
        "dashboard_url": None,
        "agents": None,
        "machine_errors": None,
        "errors": [],
    }
    try:
        state = require_state()
        report.update(deploy_status(state) or {})
    except NoDeployError as e:
        ui.warn(e)
        return report
    # RuntimeError: on Kubernetes, the forward to the cluster's API could not open.
    except (GCError, RuntimeError) as e:
        ui.fail(e)
        report["errors"].append(str(e))
        return report
    if not report["running"]:
        ui.warn("No workflow group is currently running.")
        return report

    report["controller_url"] = f"http://127.0.0.1:{state['port']}"
    ui.ok("Workflow group is running.")

    if report["endpoint"] is None:
        ui.warn(
            "Could not read the running workflow group's endpoint. Run `canyonos logs` to see why."
        )
    for name, agent in (report["agents"] or {}).items():
        if agent["launch_error"]:
            ui.warn(f"{name} could not start a replica: {agent['launch_error']}")

    dashboard_port = _existing_dashboard_port()
    report["dashboard_url"] = dashboard_url(dashboard_port) if dashboard_port else None
    ui.blank()
    keyed = not state.get("auth_disabled", False)
    ui.panel(summary_body(report["dashboard_url"], report["endpoint"], keyed))
    return report
