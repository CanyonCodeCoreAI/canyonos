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
    AgentService,
    DatabaseService,
    Manifest,
    OtelDestination,
    OtelSpec,
    RedisSpec,
    Resources,
    WorkflowService,
    load_manifest,
)

__all__ = [
    "AgentService",
    "BUILTIN_TYPE_NAMES",
    "DatabaseService",
    "DependencyPinConflict",
    "Manifest",
    "OtelDestination",
    "OtelSpec",
    "RedisSpec",
    "Resources",
    "SchemaError",
    "SchemaViolation",
    "WorkflowService",
    "check_project",
    "load_manifest",
    "render_violation",
    "validate_project",
]


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


def _missing_sources(manifest, manifest_path, source_dir):
    """Violations for the code a manifest points at but the project does not hold.

    The build used to log a line and carry on, leaving a deploy that exited 0
    with the service quietly absent from it.
    """
    if not os.path.isdir(source_dir):
        return [
            SchemaViolation(
                manifest_path,
                0,
                "agents",
                f"the project source directory {_as_typed(source_dir)} does not "
                "exist, so no service's code can be found",
            )
        ]

    violations = []
    real_source_dir = os.path.realpath(source_dir)
    for index, service in enumerate(manifest.agents):
        key = {"agent": "entrypoint", "workflow": "workflow_file"}.get(service.type)
        if key is None:
            continue
        source = os.path.join(source_dir, getattr(service, key))
        if not os.path.isfile(source):
            problem = f"{_as_typed(source)} does not exist"
        elif (
            os.path.commonpath([real_source_dir, os.path.realpath(source)])
            != real_source_dir
        ):
            problem = f"{_as_typed(source)} resolves outside the project"
        else:
            continue
        violations.append(
            SchemaViolation(manifest_path, 0, f"agents[{index}].{key}", problem)
        )
    return violations


def check_project(manifest_path, source_dir=None):
    """`(manifest, violations)` for a project's manifest.

    Never raises: the caller decides how to report. The manifest is None when
    it did not parse.

    `source_dir` is the project root the manifest's paths are relative to.
    Given one, the entrypoint and workflow file each service declares must
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

    if source_dir is not None:
        violations.extend(_missing_sources(manifest, manifest_path, source_dir))
    return manifest, tuple(violations)


def validate_project(manifest_path, source_dir=None):
    """Every violation in a project's manifest."""
    return check_project(manifest_path, source_dir)[1]
