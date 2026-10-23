# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
Logic for the pre-deploy resource picker: every agent's cpu, memory, gpu and
replicas are shown (and filled with defaults when missing), the user can change
any of them, and the result is written back to the global controller config.
"""

import math
import os
import sys

from ruamel.yaml.comments import CommentedMap

from canyonos import ui
from canyonos.constants import round_trip_yaml
from canyonos.theme import GRADIENT, GREEN, WHITE
from utils.tui import input_line, select_menu

DEPLOY = "__deploy__"
BACK = "__back__"

RESOURCE_DEFAULTS = (("cpu", 1), ("memory", 512), ("gpu", 0))
REPLICAS_DEFAULT = 1

FIELDS = ("cpu", "memory", "gpu", "replicas")
UNITS = {"cpu": "cores", "memory": "MiB"}

BOLD = "\x1b[1m"


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


def _gradient_color(position):
    """Truecolor escape for `position` (0..1) along the brand gradient."""
    scaled = position * (len(GRADIENT) - 1)
    low = min(int(scaled), len(GRADIENT) - 2)
    mix = scaled - low
    start, end = GRADIENT[low], GRADIENT[low + 1]
    rgb = (
        round(int(start[i : i + 2], 16) * (1 - mix) + int(end[i : i + 2], 16) * mix)
        for i in (1, 3, 5)
    )
    return "\x1b[38;2;{};{};{}m".format(*rgb)


def _deploy_button():
    """A boxed, gradient-colored Deploy label spanning three menu lines."""
    inner = 18
    lines = [
        "╭" + "─" * inner + "╮",
        "│" + "DEPLOY".center(inner) + "│",
        "╰" + "─" * inner + "╯",
    ]
    colored = [
        "".join(
            f"{_gradient_color(col / (inner + 1))}{BOLD if ch.isalpha() else ''}{ch}\x1b[22m"
            for col, ch in enumerate(line)
        )
        + "\x1b[0m"
        for line in lines
    ]
    return "\n".join(colored)


def _name(agent_spec, index):
    return str(agent_spec.get("name", f"[{index}]"))


def _cells(agent_specs):
    """Per agent, the name and each field padded to its column's width, plus those widths."""
    rows = [
        [_name(agent_spec, i)]
        + [f"{_label(field)} {_get(agent_spec, field)}" for field in FIELDS]
        for i, agent_spec in enumerate(agent_specs)
    ]
    widths = [max(len(row[col]) for row in rows) for col in range(len(rows[0]))]
    return [[c.ljust(w) for c, w in zip(row, widths)] for row in rows], widths


def _table(agent_specs):
    """Menu labels for the agents boxed into a table, and the bottom border as a footer."""
    rows, widths = _cells(agent_specs)
    top = "╭" + "┬".join("─" * (w + 2) for w in widths) + "╮"
    bottom = "╰" + "┴".join("─" * (w + 2) for w in widths) + "╯"
    divider = "├" + "┼".join("─" * (w + 2) for w in widths) + "┤"
    labels = [
        f"{top if i == 0 else divider}\n│ " + " │ ".join(row) + " │"
        for i, row in enumerate(rows)
    ]
    return labels, [bottom]


def _render(title, status):
    ui.console.clear()
    ui.console.print(f"[bold {GREEN}]CanyonOS[/] [{WHITE}]deploy › {title}[/]")
    if status:
        ui.console.print(f"[{GREEN}]{status}[/]")
    ui.console.print()


def _edit_agent(agent_spec, status):
    """Field menu for one agent. Returns the status line to show next."""
    name = agent_spec.get("name", "agent")
    while True:
        _render(name, status)
        options = [
            (field, f"{_label(field)}: {_get(agent_spec, field)}") for field in FIELDS
        ]
        options.append((BACK, "← Back"))
        field = select_menu(options, title=f"Resources for {name}")
        if field is None or field == BACK:
            return status

        error = None
        while True:
            _render(f"{name} › {field}", status)
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


def _pick(agent_specs):
    """Agent menu. Returns True to deploy, False if the user cancelled."""
    status = ""
    ui.console.set_alt_screen(True)
    try:
        while True:
            _render("resources", status)
            options = [(DEPLOY, _deploy_button())]
            labels, footer = _table(agent_specs)
            options += list(enumerate(labels))
            choice = select_menu(
                options, title="Configure agent resources", footer=footer
            )
            if choice is None:
                return False
            if choice == DEPLOY:
                return True
            status = _edit_agent(agent_specs[choice], status)
    finally:
        ui.console.set_alt_screen(False)


def configure_resources(config_path):
    """Fill, let the user edit, and save every agent's resources. Returns False if cancelled."""
    if not os.path.isfile(config_path):
        return True

    yaml_rt = round_trip_yaml()
    with open(config_path) as f:
        data = yaml_rt.load(f)

    agent_specs = (data or {}).get("agents") or []
    if not agent_specs:
        return True
    for agent_spec in agent_specs:
        _fill_defaults(agent_spec)

    if sys.stdin.isatty() and not _pick(agent_specs):
        return False

    with open(config_path, "w") as f:
        yaml_rt.dump(data, f)
    return True
