# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
Logic for the pre-deploy resource picker: every agent's cpu, memory, gpu and
replicas are shown (and filled with defaults when missing), the user can change
any of them, and the result is written back to the global controller config.
"""

import math
import sys

from rich.text import Text
from ruamel.yaml.comments import CommentedMap

from canyonos import ui
from canyonos.constants import load_yaml, round_trip_yaml, write_config
from canyonos.os_support import is_terminal
from canyonos.theme import GREEN, WHITE
from utils.tui import input_line, select_menu

DEPLOY = "__deploy__"
CONFIGURE = "__configure__"
BACK = "__back__"

RESOURCE_DEFAULTS = (("cpu", 1), ("memory", 512), ("gpu", 0))
REPLICAS_DEFAULT = 1

FIELDS = ("cpu", "memory", "gpu", "replicas")
UNITS = {"cpu": "cores", "memory": "MiB"}
COLUMNS = ("agent", *FIELDS)
FIELD_HELP = (
    "cpu: max CPU cores each replica can use",
    "memory: max memory each replica can use, in MiB",
    "gpu: max GPUs each replica can use",
    "replicas: how many copies of the agent to run",
)

MENU = [
    (
        DEPLOY,
        "1. Deploy\n   Launch your workflow. This is the final step before seeing it!",
    ),
    (
        CONFIGURE,
        "2. Configure an agent\n   Set the upper limit on what its replicas can use.",
    ),
]


def _fill_defaults(agent_spec):
    resources = agent_spec.get("resources")
    if not isinstance(resources, dict):
        resources = CommentedMap()
        agent_spec["resources"] = resources
    for key, default in RESOURCE_DEFAULTS:
        resources.setdefault(key, default)
    agent_spec.setdefault("replicas", REPLICAS_DEFAULT)


def _label(field):
    return f"{field} ({UNITS[field]})" if field in UNITS else field


def _get(agent_spec, field):
    return (
        agent_spec["replicas"]
        if field == "replicas"
        else agent_spec["resources"][field]
    )


def _set(agent_spec, field, value):
    if field == "replicas":
        agent_spec["replicas"] = value
    else:
        agent_spec["resources"][field] = value


DECIMAL_FIELDS = ("cpu",)


def _cast(field, raw):
    """Raises ValueError. cpu may be a decimal; the rest are whole numbers, none negative."""
    if field in DECIMAL_FIELDS:
        value = float(raw)
        if not math.isfinite(value):
            raise ValueError(raw)
        value = int(value) if value.is_integer() else value
    else:
        value = int(raw)
    if value < 0:
        raise ValueError(raw)
    return value


def _invalid_message(field, raw):
    kind = "a number" if field in DECIMAL_FIELDS else "a whole number"
    kind += ", 0 or more"
    return f"{raw!r} is not valid: {_label(field)} must be {kind}"


def _name(agent_spec, index):
    return str(agent_spec.get("name", f"[{index}]"))


def _cells(agent_specs):
    """Per agent, the name and each field padded to its column's width, plus those widths."""
    rows = [
        [_name(agent_spec, i)] + [str(_get(agent_spec, field)) for field in FIELDS]
        for i, agent_spec in enumerate(agent_specs)
    ]
    widths = [max(len(cell) for cell in column) for column in zip(COLUMNS, *rows)]
    return [[c.ljust(w) for c, w in zip(row, widths)] for row in rows], widths


def _table(agent_specs):
    """The agents as a boxed table: the top border with the column names in it, one
    line per agent, and the bottom border."""
    rows, widths = _cells(agent_specs)
    names = (f" {name} ".ljust(w + 2, "─") for name, w in zip(COLUMNS, widths))
    top = "╭" + "┬".join(names) + "╮"
    bottom = "╰" + "┴".join("─" * (w + 2) for w in widths) + "╯"
    return top, ["│ " + " │ ".join(row) + " │" for row in rows], bottom


def _render(title, status):
    ui.console.clear()
    ui.console.print(f"[bold {GREEN}]CanyonOS[/] [{WHITE}]{title}[/]")
    if status:
        ui.console.print(f"[{GREEN}]{status}[/]")
    ui.console.print()


def _edit_agent(agent_spec, status):
    """Field menu for one agent. Returns the status line to show next."""
    name = agent_spec.get("name", "agent")
    while True:
        _render(f"deploy › {name}", status)
        options = [
            (field, f"{_label(field)}: {_get(agent_spec, field)}") for field in FIELDS
        ]
        options.append((BACK, "← Back"))
        field = select_menu(options, title=f"Resources for {name}")
        if field is None or field == BACK:
            return status

        error = None
        while True:
            _render(f"deploy › {name} › {field}", status)
            raw = input_line(
                f"{_label(field)} (current {_get(agent_spec, field)}): ", error=error
            )
            if not raw:
                break
            try:
                _set(agent_spec, field, _cast(field, raw))
            except ValueError:
                error = _invalid_message(field, raw)
                continue
            status = f"Set {name} {field} = {_get(agent_spec, field)}"
            break


def _configure(agent_specs, status):
    """Agent menu: pick an agent to edit, until Esc. Returns the status line to show next."""
    while True:
        _render("deploy › configure", status)
        top, rows, bottom = _table(agent_specs)
        choice = select_menu(
            list(enumerate(rows)),
            title="Which agent do you want to configure?",
            header=[top],
            footer=[bottom],
        )
        if choice is None:
            return status
        status = _edit_agent(agent_specs[choice], status)


def _pick(agent_specs):
    """Deploy menu. Returns True to deploy, False if the user cancelled."""
    status = ""
    ui.console.set_alt_screen(True)
    try:
        while True:
            _render("", status)
            ui.console.print(
                Text(
                    "Your workflow's agents and the max resources each replica can use",
                    style="bold",
                )
            )
            ui.console.print()
            top, rows, bottom = _table(agent_specs)
            for line in (top, *rows, bottom, ""):
                ui.console.print(Text(f"  {line}"))
            for line in FIELD_HELP:
                ui.console.print(Text(f"  {line}", style="dim"))
            ui.console.print()
            choice = select_menu(MENU, title="What do you want to do?")
            if choice is None:
                return False
            if choice == DEPLOY:
                return True
            status = _configure(agent_specs, status)
    finally:
        ui.console.set_alt_screen(False)


def configure_resources(config_path):
    """Fill, let the user edit, and save every agent's resources. Returns False if cancelled."""
    yaml_rt = round_trip_yaml()
    data = load_yaml(config_path, yaml_rt.load)

    agent_specs = data.get("agents") if isinstance(data, dict) else None
    # Any other shape is left for the deploy's schema check to report.
    if (
        not agent_specs
        or not isinstance(agent_specs, list)
        or not all(isinstance(agent_spec, dict) for agent_spec in agent_specs)
    ):
        return True
    for agent_spec in agent_specs:
        _fill_defaults(agent_spec)

    if is_terminal(sys.stdin) and not _pick(agent_specs):
        return False

    write_config(config_path, data, yaml_rt)
    return True
