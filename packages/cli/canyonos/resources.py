"""
Logic for the pre-deploy resource picker: every agent's cpu, memory, gpu and
replicas are shown (and filled with defaults when missing), the user can change
any of them, and the result is written back to the global controller config.
The picker displays zero GPUs as the no-GPU default; manifests express that by
omitting `resources.gpu` rather than writing zero.
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


def _fill_defaults(agent):
    resources = agent.get("resources")
    if not isinstance(resources, dict):
        resources = CommentedMap()
        agent["resources"] = resources
    for key, default in RESOURCE_DEFAULTS:
        resources.setdefault(key, default)
    agent.setdefault("replicas", REPLICAS_DEFAULT)


def _label(field):
    return f"{field} ({UNITS[field]})" if field in UNITS else field


def _get(agent, field):
    return agent["replicas"] if field == "replicas" else agent["resources"][field]


def _set(agent, field, value):
    if field == "replicas":
        agent["replicas"] = value
    else:
        agent["resources"][field] = value


def _omit_zero_gpu(agent):
    """Use the manifest's omission form for the picker's no-GPU value."""
    resources = agent.get("resources")
    gpu = resources.get("gpu") if isinstance(resources, dict) else None
    if isinstance(gpu, (int, float)) and not isinstance(gpu, bool) and gpu == 0:
        del resources["gpu"]


DECIMAL_FIELDS = ("cpu", "gpu")


def _cast(field, raw):
    """Raises ValueError. cpu and gpu may be decimals; the rest are whole numbers."""
    if field in DECIMAL_FIELDS:
        value = float(raw)
        if not math.isfinite(value):
            raise ValueError(raw)
        return int(value) if value.is_integer() else value
    return int(raw)


def _invalid_message(field, raw):
    kind = "a number" if field in DECIMAL_FIELDS else "a whole number"
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


def _name(agent, index):
    return str(agent.get("name", f"[{index}]"))


def _cells(agents):
    """Per agent, the name and each field padded to its column's width, plus those widths."""
    rows = [
        [_name(agent, i)]
        + [f"{_label(field)} {_get(agent, field)}" for field in FIELDS]
        for i, agent in enumerate(agents)
    ]
    widths = [max(len(row[col]) for row in rows) for col in range(len(rows[0]))]
    return [[c.ljust(w) for c, w in zip(row, widths)] for row in rows], widths


def _table(agents):
    """Menu labels for the agents boxed into a table, and the bottom border as a footer."""
    rows, widths = _cells(agents)
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


def _edit_agent(agent, status):
    """Field menu for one agent. Returns the status line to show next."""
    name = agent.get("name", "agent")
    while True:
        _render(name, status)
        options = [
            (field, f"{_label(field)}: {_get(agent, field)}") for field in FIELDS
        ]
        options.append((BACK, "← Back"))
        field = select_menu(options, title=f"Resources for {name}")
        if field is None or field == BACK:
            return status

        error = None
        while True:
            _render(f"{name} › {field}", status)
            raw = input_line(
                f"{_label(field)} (current {_get(agent, field)}): ", error=error
            )
            if not raw:
                break
            try:
                _set(agent, field, _cast(field, raw))
            except ValueError:
                error = _invalid_message(field, raw)
                continue
            status = f"Set {name} {field} = {_get(agent, field)}"
            break


def _pick(agents):
    """Agent menu. Returns True to deploy, False if the user cancelled."""
    status = ""
    ui.console.set_alt_screen(True)
    try:
        while True:
            _render("resources", status)
            options = [(DEPLOY, _deploy_button())]
            labels, footer = _table(agents)
            options += list(enumerate(labels))
            choice = select_menu(
                options, title="Configure agent resources", footer=footer
            )
            if choice is None:
                return False
            if choice == DEPLOY:
                return True
            status = _edit_agent(agents[choice], status)
    finally:
        ui.console.set_alt_screen(False)


def configure_resources(config_path):
    """Fill, let the user edit, and save every agent's resources. Returns False if cancelled."""
    if not os.path.isfile(config_path):
        return True

    yaml_rt = round_trip_yaml()
    with open(config_path) as f:
        data = yaml_rt.load(f)

    agents = (data or {}).get("agents") or []
    if not agents:
        return True
    for agent in agents:
        _fill_defaults(agent)

    if sys.stdin.isatty() and not _pick(agents):
        return False

    for agent in agents:
        _omit_zero_gpu(agent)

    with open(config_path, "w") as f:
        yaml_rt.dump(data, f)
    return True
