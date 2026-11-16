# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Schema for the files a CanyonOS deployment declares itself with: its
`deployment.yaml` and each project folder's `config/workflow_config.yaml`.

`check_deployment` is what the in-container deploy calls before it generates a
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
    DEPLOYMENT_CONFIG,
    CONFIG_PATH,
    CodeAgent,
    DatabaseAgent,
    EndpointSpec,
    Manifest,
    OtelDestination,
    OtelSpec,
    Project,
    RedisSpec,
    Resources,
    load_deployment,
    load_deployment_config,
    load_project,
    project_names,
    qualified_name,
)

__all__ = [
    "DEPLOYMENT_CONFIG",
    "CONFIG_PATH",
    "CodeAgent",
    "BUILTIN_TYPE_NAMES",
    "DatabaseAgent",
    "DependencyPinConflict",
    "EndpointSpec",
    "Manifest",
    "OtelDestination",
    "OtelSpec",
    "Project",
    "RedisSpec",
    "Resources",
    "SchemaError",
    "SchemaViolation",
    "check_deployment",
    "check_project",
    "load_deployment",
    "load_deployment_config",
    "load_project",
    "project_names",
    "qualified_name",
    "render_violation",
]


def _as_typed(path):
    """A path as the reader would write it: relative to where the build runs.

    The build runs from the deployment's folder, so that is the form the config files
    and the rest of these violations are written in. A path outside it has no shorter
    honest form and is left absolute.
    """
    try:
        relative = os.path.relpath(path)
    except ValueError:  # a different drive on Windows
        return path
    return path if relative.startswith(os.pardir) else relative


def _missing_sources(agent_specs, path, root):
    """Violations for the code a project's agents point at but its folder `root` does
    not hold.

    The build used to log a line and carry on, leaving a deploy that exited 0
    with the agent quietly absent from it.
    """
    violations = []
    real_root = os.path.realpath(root)
    for index, agent_spec in enumerate(agent_specs):
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
            SchemaViolation(path, 0, f"agents[{index}].entrypoint", problem)
        )
    return violations


def check_project(root):
    """`(project, violations)` for the project folder `root`: its `config/workflow_config.yaml`
    and the code its agents point at. Never raises; the project is None when its config
    did not parse."""
    path = os.path.join(root, CONFIG_PATH)
    try:
        project = load_project(path)
    except SchemaError as error:
        return None, tuple(error.violations)
    return project, tuple(_missing_sources(project.agents, path, root))


def check_deployment(workspace):
    """`(manifest, violations)` for the deployment in `workspace`: its config files and
    the code every project's agents point at. Never raises; the manifest is None when
    the config files did not parse."""
    try:
        manifest = load_deployment(workspace)
    except SchemaError as error:
        return None, tuple(error.violations)
    violations = []
    for name in project_names(workspace):
        root = os.path.join(workspace, name)
        project_agents = [
            agent_spec for agent_spec in manifest.agents if agent_spec.project == name
        ]
        violations += _missing_sources(
            project_agents, os.path.join(root, CONFIG_PATH), root
        )
    return manifest, tuple(violations)
