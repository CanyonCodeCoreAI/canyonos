# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
Logic for `canyonos status`: reports whether a deploy is currently running,
and if so, where the workflow (and, if up, the dashboard) answer.
"""

import json

from canyonos import deployment, ui
from canyonos.api import (
    ApiError,
    NoDeployError,
    docker_api_url,
    require_state,
    workflow_group_status,
)
from canyonos.dashboard_stack import dashboard_url, running_web_port
from canyonos.deploy import summary_body


def run_status(as_json=False):
    """Run `canyonos status`: show in the terminal whether a deploy is running, where to
    reach it, how to query it, and each agent's last launch error; with `as_json`, print
    the CanyonOS API's whole status of it and where to reach it as one JSON object
    instead. Returns True when a deploy is running; raises when the status could not
    be read, which exits 1."""
    ui.set_quiet(as_json)
    try:
        report, failure = _read_status()
    finally:
        ui.set_quiet(False)
    if as_json:
        print(json.dumps(report, indent=2))
    if failure is not None:
        raise failure
    return report["running"]


def _report_status():
    """Show the status in the terminal and return it, as `_read_status` reads it."""
    report, failure = _read_status()
    if failure is not None:
        ui.fail(failure)
    return report


def _read_status():
    """Show the status in the terminal and return it: the CanyonOS API's status of the
    deploy, with why any part of it could not be read under `errors`, plus the target,
    the workflow group and where the API and the dashboard answer; and the error that
    kept it from being read at all, or None."""
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
        report.update(workflow_group_status(state) or {})
    except NoDeployError as e:
        ui.warn(e)
        return report, None
    # RuntimeError: on Kubernetes, the forward to the cluster's API could not open.
    except (ApiError, RuntimeError) as e:
        report["errors"].append(str(e))
        return report, e
    if not report["running"]:
        ui.warn("No workflow group is currently running.")
        return report, None

    report["controller_url"] = state.get("api_url") or docker_api_url()
    ui.ok("Workflow group is running.")

    if report["endpoint"] is None:
        ui.warn(
            "Could not read the running workflow group's endpoint. Run `canyonos logs` to see why."
        )
    for agent in report["agents"] or []:
        if agent["launch_error"]:
            ui.warn(
                f"{agent['name']} could not start a replica: {agent['launch_error']}"
            )

    dashboard_port = running_web_port()
    report["dashboard_url"] = dashboard_url(dashboard_port) if dashboard_port else None
    ui.blank()
    keyed = not state.get("auth_disabled", False)
    ui.panel(summary_body(report["dashboard_url"], report["endpoint"], keyed))
    return report, None
