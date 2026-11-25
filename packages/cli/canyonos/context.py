# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
Logic for `canyonos list` and `canyonos select-context`: the workflow groups on this
machine, and the one picked to act on from a folder that is no workflow group's.

The pick is the workflow group's name in `~/.canyonos/context.json`. `stop`, `clean`,
`status`, `logs`, `test`, `sync`, `curl`, `config`, `doctor`, `chat` and `serve` use it
when they are given no workflow group and run from a folder that belongs to none (see
records.py); a name or the current folder always wins.
"""

import json
from pathlib import Path

from canyonos import records, selection, ui
from canyonos.deployment import deployments_dir
from canyonos.api import ApiError, is_running, start_api_for, workflow_group_status

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
    """The selected workflow group, or None when none is selected; raise RuntimeError
    saying how to pick another when the selected one is no longer recorded on this
    machine."""
    name = _selected_name()
    if name is None:
        return None
    for recorded in selection.recorded_deployments():
        if recorded.name == name:
            return recorded
    raise RuntimeError(
        f"The selected workflow group `{name}` is no longer recorded on this machine. "
        + PICK_AGAIN
    )


def _running(recorded):
    """Whether the deploy of `recorded` runs: None when it isn't deployed, "unknown"
    when the CanyonOS API can't say."""
    if recorded.state is None:
        return None
    try:
        start_api_for(recorded.state)
        return is_running(workflow_group_status(recorded.state))
    except ApiError:
        return "unknown"


def _describe(recorded, selected_name):
    """One line of `canyonos list`: its name, ID, whether its deploy runs, unknown when
    the CanyonOS API can't say, and marks for a deploy with no API key and for the
    selected workflow group."""
    running = _running(recorded)
    marks = [
        {None: "not deployed", True: "running", False: "not running"}.get(
            running, "unknown (API down)"
        )
    ]
    if (recorded.state or {}).get("auth_disabled"):
        marks.append("(unauthenticated)")
    if recorded.name == selected_name:
        marks.append("(selected)")
    return [recorded.name, recorded.id or "no ID recorded", " ".join(marks)]


def _entry(recorded, selected_name, status=True):
    """What `canyonos list --json` says of one workflow group: `running` is true, false,
    "unknown" when the CanyonOS API can't say, or null when it isn't deployed; without
    `status`, "unchecked" for a deployed one, as the API isn't asked."""
    if status:
        running = _running(recorded)
    else:
        running = None if recorded.state is None else "unchecked"
    return {
        "name": recorded.name,
        "workflow_group_id": recorded.id,
        "record": recorded.folder,
        "deployed": recorded.state is not None,
        "running": running,
        "unauthenticated": bool((recorded.state or {}).get("auth_disabled")),
        "selected": recorded.name == selected_name,
        "target": records.target(recorded.name),
        "workflows": records.workflows(recorded.name),
    }


def _show(recorded, selected_name):
    """Show one line per workflow group of `recorded`, or how to deploy one when there is
    none."""
    if not recorded:
        ui.say(
            "No workflow group on this machine. Deploy one with "
            "`canyonos deploy <workflow folder>`."
        )
        return
    rows = [_describe(deployment, selected_name) for deployment in recorded]
    widths = [max(len(row[column]) for row in rows) for column in range(2)]
    for name, deployment_id, marks in rows:
        ui.say(f"* {name:<{widths[0]}}  {deployment_id:<{widths[1]}}  {marks}")


def run_list(as_json=False, status=True):
    """Run `canyonos list`: show every workflow group recorded on this machine, one line
    each, and warn when the selected one is gone. With `as_json`, print them as one
    JSON object instead, for scripts and the desktop app, with the folder that holds
    the records; without `status`, without asking the CanyonOS API whether each deploy
    runs (on Kubernetes, a port-forward each)."""
    recorded = selection.recorded_deployments()
    selected_name = _selected_name()
    if as_json:
        print(
            json.dumps(
                {
                    "workflow_groups": [
                        _entry(d, selected_name, status) for d in recorded
                    ],
                    "selected": selected_name,
                    "records_dir": deployments_dir(),
                },
                indent=2,
            )
        )
        return True
    _show(recorded, selected_name)
    if selected_name and selected_name not in {d.name for d in recorded}:
        ui.warn(
            f"The selected workflow group `{selected_name}` is no longer recorded on this "
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
        "stop, clean, status, logs, test, sync, curl, config, doctor, chat and serve "
        "act on it from any folder that is no workflow group's; a name or a workflow "
        "group's folder still wins."
    )
    return True
