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
from canyonos.constants import deployment_config_path, read_config
from canyonos.dashboard_stack import dashboard_url, running_web_port
from canyonos.deploy import summary_body
from canyonos.forwards import DASHBOARD, forward_port
from canyonos.kubernetes_target import current_context


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


def _kubernetes_place():
    """Where on Kubernetes the workflow group deploys: kubectl's context, as its commands
    reach the cluster, and its `kubernetes:` block's namespace."""
    block = read_config(deployment_config_path()).get("kubernetes") or {}
    return {"context": current_context(), "namespace": block.get("namespace")}


def _read_status():
    """Show the status in the terminal and return it: the CanyonOS API's status of the
    deploy, with why any part of it could not be read under `errors`, plus the target
    (on Kubernetes, the cluster's kubectl context and the namespace), the workflow group
    and where the API and the dashboard answer; and the error that kept it from being
    read at all, or None."""
    target = deployment.configured_target()
    report = {
        "running": False,
        "target": target,
        "kubernetes": _kubernetes_place() if target == "kubernetes" else None,
        "workflow_group": deployment.deployment_name(),
        "controller_url": None,
        "endpoint": None,
        "dashboard_url": None,
        "agents": None,
        "machine_errors": None,
        "errors": [],
        # Why the status couldn't be read, as `--json` names a failure: version_mismatch
        # when the deploy runs another CanyonOS release than this CLI, say.
        "failure_code": None,
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
        report["failure_code"] = getattr(e, "error_code", None) or "failed"
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

    if target == "kubernetes":
        # The cluster's dashboard, once `canyonos serve` or `dashboard` forwarded it here.
        port = forward_port(DASHBOARD)
        report["dashboard_url"] = f"http://127.0.0.1:{port}" if port else None
    else:
        port = running_web_port()
        report["dashboard_url"] = dashboard_url(port) if port else None
    ui.blank()
    keyed = not state.get("auth_disabled", False)
    ui.panel(summary_body(report["dashboard_url"], report["endpoint"], keyed))
    return report, None
