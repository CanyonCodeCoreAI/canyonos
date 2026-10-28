# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Schema for the files a CanyonOS project declares itself with.

`validate_project` is what the in-container deploy calls before it generates a
single stub: a manifest key that does not exist, a port written as a string or
an argument annotated with a type the stub cannot import is a failure with a
file and a line, not a warning followed by a build.
"""

import os

from canyonos_core.schema.errors import (
    DependencyPinConflict,
    SchemaError,
    SchemaViolation,
    render_violation,
)
from canyonos_core.schema.functions import BUILTIN_TYPE_NAMES
from canyonos_core.schema.manifest import (
    CodeAgent,
    DatabaseAgent,
    EndpointSpec,
    Manifest,
    OtelDestination,
    OtelSpec,
    RedisSpec,
    Resources,
    load_manifest,
)

__all__ = [
    "CONFIG_PATH",
    "CodeAgent",
    "BUILTIN_TYPE_NAMES",
    "DatabaseAgent",
    "DependencyPinConflict",
    "EndpointSpec",
    "Manifest",
    "OtelDestination",
    "OtelSpec",
    "RedisSpec",
    "Resources",
    "SchemaError",
    "SchemaViolation",
    "check_project",
    "load_manifest",
    "render_violation",
    "validate_project",
]

# The manifest, relative to the project root.
CONFIG_PATH = os.path.join("config", "global_controller.yaml")


def _as_typed(path):
    """A path as the reader would write it: relative to where the build runs.

    The build runs from the project root, so that is the form the manifest and
    the rest of these violations are written in. A path outside it has no
    shorter honest form and is left absolute.
    """
    try:
        relative = os.path.relpath(path)
    except ValueError:  # a different drive on Windows
        return path
    return path if relative.startswith(os.pardir) else relative


def _missing_sources(manifest, manifest_path, root):
    """Violations for the code a manifest points at but the project does not hold.

    The build used to log a line and carry on, leaving a deploy that exited 0
    with the agent quietly absent from it.
    """
    if not os.path.isdir(root):
        return [
            SchemaViolation(
                manifest_path,
                0,
                "agents",
                f"the project folder {_as_typed(root)} does not "
                "exist, so no agent's code can be found",
            )
        ]

    violations = []
    real_root = os.path.realpath(root)
    for index, agent_spec in enumerate(manifest.agents):
        if agent_spec.type != "agent":
            continue
        source = os.path.join(root, agent_spec.entrypoint)
        if not os.path.isfile(source):
            problem = f"{_as_typed(source)} does not exist"
        elif os.path.commonpath([real_root, os.path.realpath(source)]) != real_root:
            problem = f"{_as_typed(source)} resolves outside the project"
        else:
            continue
        violations.append(
            SchemaViolation(manifest_path, 0, f"agents[{index}].entrypoint", problem)
        )
    return violations


def check_project(manifest_path, root=None):
    """`(manifest, violations)` for a project's manifest.

    Never raises: the caller decides how to report. The manifest is None when
    it did not parse.

    `root` is the project root the manifest's paths are relative to.
    Given one, the entrypoint each agent declares must
    exist under it; left out, nothing on disk is checked.
    """
    manifest = None
    violations = []
    try:
        manifest = load_manifest(manifest_path)
    except SchemaError as error:
        violations.extend(error.violations)

    if manifest is None:
        return None, tuple(violations)

    if root is not None:
        violations.extend(_missing_sources(manifest, manifest_path, root))
    return manifest, tuple(violations)


def validate_project(manifest_path, root=None):
    """Every violation in a project's manifest."""
    return check_project(manifest_path, root)[1]
