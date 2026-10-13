"""Break a copied port's manifest so `canyonos validate` has to reject it.

Each mode rewrites the first agent's first function in one way its stub
cannot be generated from, and prints the text the finding has to contain.

Usage: break_manifest.py <.car> <mode>
"""

import sys
from pathlib import Path

import yaml


def rename(agent, function):
    function["name"] += "_missing"
    return f"`{agent['name']}` has no method `{function['name']}`"


def builtin(agent, function):
    function["name"] = "list"
    return "'list' would shadow the builtin type"


def dunder(agent, function):
    function["name"] = "__init__"
    return "'__init__' is reserved for Python"


def duplicate(agent, function):
    agent["functions"].append(dict(function))
    return f"'{function['name']}' is already a function of this agent"


def returns(agent, function):
    function["returns"] = {"type": "pandas.DataFrame"}
    return "'pandas.DataFrame' is not built from builtin types"


def deep(agent, function):
    function["returns"] = {"type": " | ".join(["int"] * 20000)}
    return "is not built from builtin types"


MODES = {f.__name__: f for f in (rename, builtin, dunder, duplicate, returns, deep)}

car, mode = sys.argv[1:]
path = Path(car) / "config" / "global_controller.yaml"
manifest = yaml.safe_load(path.read_text())
agent = next(
    service for service in manifest["agents"] if service.get("type", "agent") == "agent"
)
print(MODES[mode](agent, agent["functions"][0]))
path.write_text(yaml.safe_dump(manifest, sort_keys=False))
