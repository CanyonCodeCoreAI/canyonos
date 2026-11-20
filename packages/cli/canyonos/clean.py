# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Logic for canyonos clean: stop each workflow group it is given or picks (see
selection.py) if it is deployed, then remove its record under `~/.canyonos/workflows/`,
its settings included, and agent images, and the `.canyon` and CanyonOS skills of the
folder it runs from; with --all, everything CanyonOS put
on this machine."""

import os
import shutil

from canyonos import convert, deployment, records, selection, ui
from canyonos.constants import CANYON_DIR
from canyonos.stop import (
    agent_images,
    confirm_clean_all,
    ensure_api_for_stop,
    remove_images,
    stop_all,
    stop_unused_dashboard,
    stopper,
)

# What `canyonos clean` removes from a workflow's folder: its port and the skill
# `canyonos convert` installs there for each coding agent, leaving global installs.
_SKILL_DIRS = tuple(spec["skill_dirs"]["local"] for spec in convert.AGENTS.values())
_LOCAL_FILES = (CANYON_DIR, *_SKILL_DIRS)


def _local_files(folder, names=_LOCAL_FILES):
    """The paths of `names` under `folder` that exist."""
    paths = (os.path.join(os.path.abspath(folder), path) for path in names)
    return [path for path in paths if os.path.lexists(path)]


def _remove_emptied_parents(path, root):
    """Remove the folders between `path` and `root` that its removal left empty."""
    root = os.path.abspath(root)
    parent = os.path.dirname(path)
    while parent != root and not os.listdir(parent):
        os.rmdir(parent)
        parent = os.path.dirname(parent)


def _remove_local_files(folder, names=_LOCAL_FILES):
    """Remove the `names` of the workflow in `folder`; False when one stayed."""
    removed_all = True
    for path in _local_files(folder, names):
        try:
            if os.path.islink(path):
                os.unlink(path)
            else:
                shutil.rmtree(path)
            _remove_emptied_parents(path, folder)
        except OSError as error:
            ui.warn(f"Could not remove {path}: {error}")
            removed_all = False
            continue
        ui.ok(f"Removed {path}.")
    return removed_all


def _remove_records(name):
    """Delete workflow group `name`'s record under `~/.canyonos/workflows/`, its
    `workflow_group.yaml` and its Redis password among them; False when it stayed."""
    records = deployment.state_dir(name)
    if os.path.realpath(os.getcwd()) == os.path.realpath(records):
        # Run from it (see records.enter): what runs after, `docker compose` among
        # it, needs a folder that is still there.
        os.chdir(deployment.deployments_dir())
    try:
        shutil.rmtree(records)
    except FileNotFoundError:
        return True
    except OSError as error:
        ui.warn(f"Could not remove {records}: {error}")
        return False
    ui.ok(f"Removed {records}.")
    return True


def _clean_deployment(target, stop):
    """Stop `target` with `stop` if it is deployed, then remove the skills `convert`
    installed in its workflow folders (or, for a folder no workflow group records, its
    `.canyon` too), its record under `~/.canyonos` and its agents' images; False when
    any of it stayed."""
    # Docker won't remove the image of a container that still runs.
    if target.state is not None and stop(target.state, target.name):
        ui.fail(f"{target.name} could not be stopped, so nothing of it was cleaned.")
        return False
    if target.name in records.names():
        # A recorded workflow group's workflows keep their `.canyon`.
        folders = [
            path for path in records.workflow_paths(target.name) if os.path.isdir(path)
        ]
        removed = all([_remove_local_files(folder, _SKILL_DIRS) for folder in folders])
    else:
        folders = [target.folder] if os.path.isdir(target.folder or "") else []
        removed = all([_remove_local_files(folder) for folder in folders])
    if not folders:
        ui.hint(
            f"{target.name}'s folders are not on this machine any more, so only its "
            "deploy, records and images were removed."
        )
    records_removed = _remove_records(target.name)
    failures = remove_images([agent_images(target.name)])
    for failure in failures:
        ui.warn(failure)
    return removed and records_removed and not failures


def _candidates():
    """Every recorded workflow group, and the current folder's when it holds something to
    clean and isn't deployed."""
    deployed = selection.recorded_deployments()
    here = selection.current_deployment()
    if _local_files(here.folder) and here.name not in {p.name for p in deployed}:
        return [*deployed, here]
    return deployed


def run_clean(all_deployments=False, yes=False, refs=()):
    """Run `canyonos clean` on the workflow groups `refs` name or `selection.choose` picks:
    stop each that is deployed, then remove its `.canyon`, CanyonOS skills, records
    and agents' images. With `all_deployments`, `stop_all(remove_everything=True)`,
    asked first unless `yes`. Returns False if a workflow group wasn't found or any could
    not be removed."""
    if all_deployments:
        if not yes and not confirm_clean_all():
            return False
        return stop_all(remove_everything=True)
    choice = selection.choose("clean", refs, _candidates())
    ui.json_result["workflow_groups"] = [target.name for target in choice.deployments]
    if not choice.deployments:
        if choice.ok:
            ui.say(
                "Nothing to clean: there is no workflow group, and this folder holds no "
                "CanyonOS workflow."
            )
        return choice.ok
    deployed = [target for target in choice.deployments if target.state is not None]
    if deployed:
        ensure_api_for_stop()
    stop = stopper(choice)
    cleaned = [_clean_deployment(target, stop) for target in choice.deployments]
    if deployed and not stop_unused_dashboard(deployed):
        cleaned.append(False)
    if not all(cleaned):
        ui.fail("Clean incomplete; see the warnings above.")
        return False
    ui.ok("Clean complete.")
    return choice.ok
