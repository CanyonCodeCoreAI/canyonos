# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Ways to break a copied port's manifest so `canyonos validate` has to reject it.

Each mode names a method the agent does not have, so no stub can be generated,
names an agent the way the manifest forbids, sets a retired key, or points
ssh_private_key_path at an unset variable, and returns the text one finding's
summary has to contain.
"""

from pathlib import Path

import yaml


def rename(manifest, agent, function):
    function["name"] += "_missing"
    return f"`{agent['name']}` has no method `{function['name']}`"


def endpoint_name(manifest, agent, function):
    if manifest["endpoint"]["agent"] == agent["name"]:
        manifest["endpoint"]["agent"] = "endpoint"
    agent["name"] = "endpoint"
    return "'endpoint' is reserved for the HTTP endpoint container"


def env_file(manifest, agent, function):
    manifest["env_file"] = ".env"
    return "env_file: is no longer used"


def ssh_key_env(manifest, agent, function):
    manifest["ssh_private_key_path"] = "${CANYONOS_E2E_UNSET_SSH_KEY}"
    return (
        "'${CANYONOS_E2E_UNSET_SSH_KEY}' names an environment variable that is not set"
    )


MODES = {f.__name__: f for f in (rename, endpoint_name, env_file, ssh_key_env)}


def rewrite_manifest(canyon: Path, edit) -> None:
    """Load `canyon/config/global_controller.yaml`, let `edit` change it in place,
    and write it back as plain YAML."""
    path = canyon / "config" / "global_controller.yaml"
    manifest = yaml.safe_load(path.read_text())
    edit(manifest)
    path.write_text(yaml.safe_dump(manifest, sort_keys=False))


def break_manifest(canyon: Path, mode: str) -> str:
    """Break `canyon/config/global_controller.yaml` the way `mode` says and return
    the text one finding's summary has to contain."""
    expected = []

    def edit(manifest):
        agent = next(
            spec for spec in manifest["agents"] if spec.get("type", "agent") == "agent"
        )
        expected.append(MODES[mode](manifest, agent, agent["functions"][0]))

    rewrite_manifest(canyon, edit)
    return expected[0]
