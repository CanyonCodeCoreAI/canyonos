# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
Logic for `canyonos target`: show where this project deploys, or choose it once in
its `workflow_config.yaml`, so every command in the folder goes there.

`canyonos target kubernetes` also fills in the `kubernetes:` block a deploy there
needs, and both report whether this machine can reach the target, with the same
checks `canyonos doctor` runs.
"""

from ruamel.yaml.comments import CommentedMap

from canyonos import ui
from canyonos.constants import existing_config_path, round_trip_yaml, write_config
from canyonos.doctor import _pre_deploy_checks, _run_checks
from canyonos.kubernetes_target import (
    cluster_checks,
    current_context,
    local_registry,
    resource_name,
)
from canyonos.project import configured_target, folder_name

DOCKER = "Docker on this machine"


def run_target(target=None, namespace=None, registry=None):
    """Run `canyonos target`: with no target, show this project's; with one, write it
    to the config. Returns whether this machine can reach the target."""
    config_path = existing_config_path()
    if target is None:
        return _show(config_path)
    if target == "kubernetes":
        return _use_kubernetes(config_path, namespace, registry)
    if namespace or registry:
        raise RuntimeError(
            "--namespace and --registry go with `canyonos target kubernetes`"
        )
    return _use_docker(config_path)


def _show(config_path):
    if configured_target(config_path) == "docker":
        ui.say(f"This project deploys to {DOCKER}.")
        return _run_checks(_pre_deploy_checks())
    block = _load(config_path)[1].get("kubernetes") or {}
    ui.say(
        f"This project deploys to Kubernetes: namespace {block.get('namespace')}, "
        f"images in {block.get('registry')}, on {_cluster()}."
    )
    return _run_checks(cluster_checks(), stop_at_failure=True)


def _use_docker(config_path):
    yaml_rt, data = _load(config_path)
    if "target" in data:
        data["target"] = "docker"
        write_config(config_path, data, yaml_rt)
    ui.ok(f"This project deploys to {DOCKER}")
    return _run_checks(_pre_deploy_checks())


def _use_kubernetes(config_path, namespace, registry):
    """Write `target: kubernetes` and the `kubernetes:` block, keeping what the block
    already says unless an option replaces it."""
    yaml_rt, data = _load(config_path)
    block = data.get("kubernetes")
    if not isinstance(block, dict):
        block = CommentedMap()
    namespace = namespace or block.get("namespace") or resource_name(folder_name())
    registry = (
        registry
        or block.get("registry")
        or local_registry()
        or ui.ask(
            "Registry the cluster pulls images from (such as registry.example.com/team)"
        )
    )
    if not registry:
        raise RuntimeError(
            "Name the registry the cluster pulls images from: canyonos target "
            "kubernetes --registry <host/path>"
        )
    block["namespace"] = namespace
    block["registry"] = registry
    if "target" in data:
        data["target"] = "kubernetes"
    else:
        # First, where the config's order puts it.
        data.insert(0, "target", "kubernetes")
    if "kubernetes" in data:
        data["kubernetes"] = block
    else:
        _insert_under_target(data, block)
    write_config(config_path, data, yaml_rt)
    ui.ok(
        f"This project deploys to Kubernetes: namespace {namespace}, images in "
        f"{registry}, on {_cluster()}"
    )
    return _run_checks(cluster_checks(), stop_at_failure=True)


def _insert_under_target(data, block):
    """Put the new `kubernetes:` block right under `target`, the setting it goes with.
    The blank line and comment after `target` belong to the key that follows it, so
    they move to the end of the block."""
    data.insert(list(data).index("target") + 1, "kubernetes", block)
    comment = data.ca.items.get("target")
    if comment and comment[2] is not None:
        block.ca.items[list(block)[-1]] = [None, None, comment[2], None]
        comment[2] = None


def _load(config_path):
    yaml_rt = round_trip_yaml()
    with open(config_path, encoding="utf-8") as f:
        data = yaml_rt.load(f)
    if not isinstance(data, dict):
        raise RuntimeError(f"{config_path} must contain a YAML mapping")
    return yaml_rt, data


def _cluster():
    try:
        context = current_context()
    except RuntimeError:
        context = None
    return f"the cluster of kubectl context {context}" if context else "no cluster yet"
