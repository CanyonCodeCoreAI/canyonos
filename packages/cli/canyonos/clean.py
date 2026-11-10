# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Logic for canyonos clean: stop each project it is given or picks (see
selection.py) if it is deployed, then remove its `.canyon`, CanyonOS skills and agent
images; with --all, everything CanyonOS put on this machine."""

import os
import shutil

from canyonos import convert, selection, ui
from canyonos.constants import CANYON_DIR, default_config_path
from canyonos.stop import (
    agent_images,
    confirm_clean_all,
    remove_images,
    stop_all,
    stop_unused_dashboard,
    stopper,
)

# What `canyonos clean` removes from a project's folder: its port and the skill
# `canyonos convert` installs there for each coding agent, leaving global installs.
_LOCAL_FILES = (
    CANYON_DIR,
    *(spec["skill_dirs"]["local"] for spec in convert.AGENTS.values()),
)


def _local_files(folder):
    """The paths under `folder` that `canyonos clean` removes and that exist."""
    paths = (os.path.join(os.path.abspath(folder), path) for path in _LOCAL_FILES)
    return [path for path in paths if os.path.lexists(path)]


def _remove_emptied_parents(path, root):
    """Remove the folders between `path` and `root` that its removal left empty."""
    root = os.path.abspath(root)
    parent = os.path.dirname(path)
    while parent != root and not os.listdir(parent):
        os.rmdir(parent)
        parent = os.path.dirname(parent)


def _remove_local_files(folder):
    """Remove the local files of the project in `folder`; False when one stayed."""
    removed_all = True
    for path in _local_files(folder):
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


def _clean_project(target, stop):
    """Stop `target` with `stop` if it is deployed, then remove its local files and its
    agents' images; False when any of it stayed."""
    # Docker won't remove the image of a container that still runs.
    if target.state is not None and stop(target.state, target.name):
        ui.fail(f"{target.name} could not be stopped, so nothing of it was cleaned.")
        return False
    removed = True
    if target.folder is not None and os.path.isdir(target.folder):
        removed = _remove_local_files(target.folder)
    else:
        ui.hint(
            f"{target.name}'s folder is not on this machine any more, so only its "
            "deploy and images were removed."
        )
    failures = remove_images([agent_images(target.name)])
    for failure in failures:
        ui.warn(failure)
    return removed and not failures


def _candidates():
    """Every deployed project, and the current folder's when it holds something to
    clean and isn't deployed."""
    deployed = selection.deployed_projects()
    here = selection.current_project()
    holds_files = _local_files(here.folder) or os.path.isfile(default_config_path())
    if holds_files and here.name not in {p.name for p in deployed}:
        return [*deployed, here]
    return deployed


def run_clean(all_projects=False, yes=False, refs=()):
    """Run `canyonos clean` on the projects `refs` name or `selection.choose` picks:
    stop each that is deployed, then remove its `.canyon`, CanyonOS skills and
    agents' images. With `all_projects`, `stop_all(remove_everything=True)`, asked
    first unless `yes`. Returns False if a project wasn't found or any could not be
    removed."""
    if all_projects:
        if not yes and not confirm_clean_all():
            return False
        return stop_all(remove_everything=True)
    choice = selection.choose("clean", refs, _candidates())
    if not choice.projects:
        if choice.ok:
            ui.say(
                "Nothing to clean: no project is deployed, and this folder holds no "
                "CanyonOS project."
            )
        return choice.ok
    stop = stopper(choice)
    cleaned = [_clean_project(target, stop) for target in choice.projects]
    deployed = [target for target in choice.projects if target.state is not None]
    if deployed and not stop_unused_dashboard(deployed):
        cleaned.append(False)
    if not all(cleaned):
        ui.fail("Clean incomplete; see the warnings above.")
        return False
    ui.ok("Clean complete.")
    return choice.ok
