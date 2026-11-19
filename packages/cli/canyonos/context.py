# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
Logic for `canyonos list` and `canyonos select-context`: the workflow groups on this
machine, and the one picked to act on from a folder that is no workflow group's.

The pick is the workflow group's name in `~/.canyonos/context.json`. `stop`, `clean`,
`status`, `logs`, `test`, `sync` and `curl` use it when they are given no workflow group
and run outside a workflow group folder; a name or the current folder always wins.
"""

import json
import os
from pathlib import Path

from canyonos import selection, ui
from canyonos.api import ApiError, is_running, start_api_for, workflow_group_status
from canyonos.constants import deployment_config_path

CONTEXT_FILE = Path.home() / ".canyonos" / "context.json"
PICK_AGAIN = (
    "See the workflow groups with `canyonos list`, then pick one with "
    "`canyonos select-context <workflow group>`, or `canyonos select-context --clear`."
)


def _selected_name():
    """The name of the selected workflow group, or None when none is selected."""
    try:
        return json.loads(CONTEXT_FILE.read_text(encoding="utf-8"))["deployment"]
    except FileNotFoundError:
        return None
    except (OSError, ValueError, KeyError, TypeError) as e:
        raise RuntimeError(
            f"Could not read the selected workflow group in {CONTEXT_FILE}: {e}. "
            + PICK_AGAIN
        ) from None


def selected_deployment():
    """The selected workflow group, or None when none is selected or the command runs in a
    workflow group folder, which wins; raise RuntimeError saying how to pick another when
    the selected one is no longer recorded on this machine."""
    if os.path.isfile(deployment_config_path()):
        return None
    name = _selected_name()
    if name is None:
        return None
    for recorded in selection.recorded_deployments():
        if recorded.name == name:
            return recorded
    raise RuntimeError(
        f"The selected workflow group `{name}` is no longer deployed on this machine. "
        + PICK_AGAIN
    )


def enter_selected_folder(selected):
    """Run the rest of the command from the folder of `selected`, as if it were typed
    there; raise RuntimeError when the folder is gone or was never recorded."""
    if not selected.folder or not os.path.isfile(
        os.path.join(selected.folder, deployment_config_path())
    ):
        raise RuntimeError(
            f"The folder of the selected workflow group `{selected.name}` "
            f"({selected.folder or 'not recorded'}) no longer holds its "
            f"{deployment_config_path()}. " + PICK_AGAIN
        )
    os.chdir(selected.folder)


def _describe(recorded, selected_name):
    """One line of `canyonos list`: its name, ID, whether its deploy runs, unknown when
    the CanyonOS API can't say, and marks for a deploy with no API key and for the
    selected workflow group."""
    try:
        start_api_for(recorded.state)
        running = is_running(workflow_group_status(recorded.state))
        marks = ["running" if running else "not running"]
    except ApiError:
        marks = ["unknown (API down)"]
    if recorded.state.get("auth_disabled"):
        marks.append("(unauthenticated)")
    if recorded.name == selected_name:
        marks.append("(selected)")
    return [recorded.name, recorded.id or "no ID recorded", " ".join(marks)]


def _show(recorded, selected_name):
    """Show one line per workflow group of `recorded`, or how to deploy one when there is
    none."""
    if not recorded:
        ui.say(
            "No workflow group on this machine. Deploy one with "
            "`canyonos deploy <workflow folder> --workflow-group <group>`."
        )
        return
    rows = [_describe(deployment, selected_name) for deployment in recorded]
    widths = [max(len(row[column]) for row in rows) for column in range(2)]
    for name, deployment_id, marks in rows:
        ui.say(f"* {name:<{widths[0]}}  {deployment_id:<{widths[1]}}  {marks}")


def run_list():
    """Run `canyonos list`: show every workflow group recorded on this machine, one line
    each, and warn when the selected one is gone."""
    recorded = selection.recorded_deployments()
    selected_name = _selected_name()
    _show(recorded, selected_name)
    if selected_name and selected_name not in {d.name for d in recorded}:
        ui.warn(
            f"The selected workflow group `{selected_name}` is no longer deployed on this "
            "machine. " + PICK_AGAIN
        )
    return True


def run_select_context(ref, clear=False):
    """Run `canyonos select-context`: remember the recorded workflow group `ref` names, by
    name, folder name or ID (or its start), as `stop` takes it, or forget the pick
    with `clear`. Returns False when `ref` names no workflow group, or several."""
    if clear:
        CONTEXT_FILE.unlink(missing_ok=True)
        ui.ok("No workflow group is selected.")
        return True
    if ref is None:
        ui.fail("Name the workflow group to select, or pass --clear. " + PICK_AGAIN)
        return False
    choice = selection.choose("select-context", [ref], selection.recorded_deployments())
    if not choice.ok:
        ui.hint("See the workflow groups with `canyonos list`.")
        return False
    picked = choice.deployments[0]
    CONTEXT_FILE.parent.mkdir(parents=True, exist_ok=True)
    CONTEXT_FILE.write_text(
        json.dumps({"deployment": picked.name}, indent=2), encoding="utf-8"
    )
    ui.ok(f"Selected {picked.name}")
    ui.hint(
        "stop, clean, status, logs, test, sync and curl act on it from any folder "
        "that is no workflow group's; a name or a workflow group folder still wins."
    )
    return True
