# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
The workflow groups `canyonos stop` and `canyonos clean` act on, from any folder.

A workflow group is listed when it has a record under
`~/.canyonos/workflows/<workflow group>/` (see records.py): `canyonos deploy` writes its
state there and a stop removes that, so a deploy whose Global Controller died is still
listed as deployed, and stopping it removes what is left. A command picks workflow groups as Docker picks containers, by name or ID.
Without names, it acts on its only candidate, or asks which ones in a menu.
"""

import os
from dataclasses import dataclass

from canyonos import deployment, records, ui
from canyonos.constants import DEPLOYMENT_CONFIG, deployment_config_path, read_config
from canyonos.init import load_state
from canyonos.usage.consent import is_interactive
from utils.tui import multi_select_menu


@dataclass(frozen=True)
class Deployment:
    """A workflow group on this machine: its name (`<folder>-<id[:8]>`, which names its
    Docker group and its record), its workflow_group_id, its record's folder, and the
    state of its deploy, None when it isn't deployed."""

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
        """True when `ref` is this workflow group's full ID, name, or name without the
        start of its ID, as the folder it is named after is called."""
        return ref in (self.id, self.name, self.name.rsplit("-", 1)[0])


def recorded_deployments():
    """Every workflow group recorded on this machine, by name. An unreadable state file
    raises RuntimeError, naming the file to remove."""
    deployments = []
    for name in records.names():
        try:
            state = load_state(deployment.state_path(name))
        except FileNotFoundError:
            state = None
        config = read_config(
            os.path.join(deployment.state_dir(name), DEPLOYMENT_CONFIG)
        )
        deployments.append(
            Deployment(
                name,
                (state or {}).get("workflow_group_id")
                or config.get("workflow_group_id"),
                deployment.state_dir(name),
                state,
            )
        )
    return deployments


@dataclass(frozen=True)
class Choice:
    """The workflow groups a command acts on. `confirmed` when the user named or ticked
    them, rather than they being the only candidate; `ok` is False when a ref failed,
    the choice was cancelled, or there was no terminal to ask in."""

    deployments: list[Deployment]
    confirmed: bool
    ok: bool


def current_deployment():
    """The workflow group of the folder the command runs from, deployed or not."""
    return Deployment(
        deployment.deployment_name(),
        read_config(deployment_config_path()).get("workflow_group_id"),
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
            ui.fail(
                f"No workflow group is named `{ref}` or has an ID starting with it."
            )
        else:
            ui.fail(
                f"`{ref}` matches {len(matches)} workflow groups; name one by its ID:\n- "
                + "\n- ".join(f"{p.id or p.name} · {p.label}" for p in matches)
            )
    return chosen, resolved


def choose(command, refs, candidates):
    """The `Choice` of candidates `canyonos <command>` acts on: those `refs` name, else
    the only one, else those ticked in a menu, where the current folder's workflow group
    starts ticked."""
    if refs:
        chosen, resolved = _resolve(refs, candidates)
        return Choice(chosen, True, resolved)
    if len(candidates) <= 1:
        return Choice(candidates, False, True)
    if not is_interactive():
        ui.fail(
            f"`canyonos {command}` can act on {len(candidates)} workflow groups, and there "
            "is no terminal to ask which:\n- "
            + "\n- ".join(f"{p.id or p.name} · {p.label}" for p in candidates)
        )
        ui.hint(f"Name the ones to {command}: `canyonos {command} <name or ID>...`.")
        return Choice([], False, False)
    here = records.matching_cwd()
    chosen = multi_select_menu(
        [(p, p.label) for p in candidates],
        title=f"Select the workflow groups to {command}",
        selected=[p for p in candidates if p.name in here],
    )
    if not chosen:
        ui.say(f"No workflow group selected, so `canyonos {command}` did nothing.")
        return Choice([], False, False)
    return Choice(chosen, True, True)
