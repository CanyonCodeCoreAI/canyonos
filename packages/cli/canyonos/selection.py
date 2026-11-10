# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
The projects `canyonos stop` and `canyonos clean` act on, from any folder.

A deployed project is one with a record under `~/.canyonos/projects/<project>/`:
`canyonos deploy` writes it and a stop removes it, so a deploy whose Global
Controller died is still listed, and stopping it removes what is left. A command
picks projects as Docker picks containers, by name or ID. Without names, it acts
on its only candidate, or asks which ones in a menu.
"""

import os
from dataclasses import dataclass

from canyonos import project, ui
from canyonos.constants import default_config_path, read_config
from canyonos.init import load_state
from canyonos.usage.consent import is_interactive
from utils.tui import multi_select_menu


@dataclass(frozen=True)
class Project:
    """A project on this machine: its name (`<folder>-<id[:8]>`, which names its
    Docker group and its records), its project_id, its folder, and its deploy record,
    None when it isn't deployed. A record written before the CLI recorded the
    project_id and folder has neither."""

    name: str
    id: str | None
    folder: str | None
    state: dict | None

    @property
    def label(self):
        where = self.folder or "folder not recorded"
        deployed = "" if self.state is not None else " · not deployed"
        return f"{self.name} · {where}{deployed}"

    def named(self, ref):
        """True when `ref` is this project's full ID, name or folder name."""
        folder = os.path.basename(self.folder) if self.folder else None
        return ref in (self.id, self.name, folder)


def deployed_projects():
    """Every project deployed on this machine, by name. An unreadable record raises
    RuntimeError, naming the file to remove."""
    try:
        names = sorted(os.listdir(project.projects_dir()))
    except FileNotFoundError:
        return []
    projects = []
    for name in names:
        try:
            state = load_state(project.state_path(name))
        except FileNotFoundError:
            continue
        projects.append(
            Project(name, state.get("project_id"), state.get("project_dir"), state)
        )
    return projects


@dataclass(frozen=True)
class Choice:
    """The projects a command acts on. `confirmed` when the user named or ticked them,
    rather than they being the only candidate; `ok` is False when a ref failed, the
    choice was cancelled, or there was no terminal to ask in."""

    projects: list[Project]
    confirmed: bool
    ok: bool


def current_project():
    """The project in the folder the command runs from, deployed or not."""
    return Project(
        project.project_name(),
        read_config(default_config_path()).get("project_id"),
        os.getcwd(),
        None,
    )


def _resolve(refs, candidates):
    """The candidates `refs` name, as Docker resolves a container: a full ID, name or
    folder name first, else the start of an ID. A ref matching no candidate or
    several is reported. Returns the named candidates, and False when a ref failed."""
    chosen, resolved = [], True
    for ref in dict.fromkeys(refs):
        matches = [p for p in candidates if p.named(ref)] or [
            p for p in candidates if ref and p.id and p.id.startswith(ref)
        ]
        if len(matches) == 1:
            if matches[0] not in chosen:
                chosen.append(matches[0])
            continue
        resolved = False
        if not matches:
            ui.fail(f"No project is named `{ref}` or has an ID starting with it.")
        else:
            ui.fail(
                f"`{ref}` matches {len(matches)} projects; name one by its ID:\n- "
                + "\n- ".join(f"{p.id or p.name} · {p.label}" for p in matches)
            )
    return chosen, resolved


def choose(command, refs, candidates):
    """The `Choice` of candidates `canyonos <command>` acts on: those `refs` name, else
    the only one, else those ticked in a menu, where the current folder's project
    starts ticked."""
    if refs:
        chosen, resolved = _resolve(refs, candidates)
        return Choice(chosen, True, resolved)
    if len(candidates) <= 1:
        return Choice(candidates, False, True)
    if not is_interactive():
        ui.fail(
            f"`canyonos {command}` can act on {len(candidates)} projects, and there "
            "is no terminal to ask which:\n- "
            + "\n- ".join(f"{p.id or p.name} · {p.label}" for p in candidates)
        )
        ui.hint(f"Name the ones to {command}: `canyonos {command} <name or ID>...`.")
        return Choice([], False, False)
    here = os.getcwd()
    chosen = multi_select_menu(
        [(p, p.label) for p in candidates],
        title=f"Select the projects to {command}",
        selected=[p for p in candidates if p.folder == here],
    )
    if not chosen:
        ui.say(f"No project selected, so `canyonos {command}` did nothing.")
        return Choice([], False, False)
    return Choice(chosen, True, True)
