# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Break a copied port's manifest so `canyonos validate` has to reject it.

Each mode rewrites the first agent's first function in one way its stub
cannot be generated from, or names an agent in a way the manifest forbids, and
prints the text the finding has to contain.

Usage: break_manifest.py <.canyon> <mode>
"""

import sys
from pathlib import Path

import yaml


def rename(manifest, agent, function):
    function["name"] += "_missing"
    return f"`{agent['name']}` has no method `{function['name']}`"


def builtin(manifest, agent, function):
    function["name"] = "list"
    return "'list' would shadow the builtin type"


def dunder(manifest, agent, function):
    function["name"] = "__init__"
    return "'__init__' is reserved for Python"


def duplicate(manifest, agent, function):
    agent["functions"].append(dict(function))
    return f"'{function['name']}' is already a function of this agent"


def returns(manifest, agent, function):
    function["returns"] = {"type": "pandas.DataFrame"}
    return "'pandas.DataFrame' is not built from builtin types"


def deep(manifest, agent, function):
    function["returns"] = {"type": " | ".join(["int"] * 20000)}
    return "is not built from builtin types"


def endpoint_name(manifest, agent, function):
    if manifest["endpoint"]["agent"] == agent["name"]:
        manifest["endpoint"]["agent"] = "endpoint"
    agent["name"] = "endpoint"
    return "'endpoint' is reserved for the HTTP endpoint container"


MODES = {
    f.__name__: f
    for f in (rename, builtin, dunder, duplicate, returns, deep, endpoint_name)
}

canyon, mode = sys.argv[1:]
path = Path(canyon) / "config" / "global_controller.yaml"
manifest = yaml.safe_load(path.read_text())
agent = next(
    service for service in manifest["agents"] if service.get("type", "agent") == "agent"
)
print(MODES[mode](manifest, agent, agent["functions"][0]))
path.write_text(yaml.safe_dump(manifest, sort_keys=False))
