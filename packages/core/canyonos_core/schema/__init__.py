"""Schema for the files a CanyonOS project declares itself with.

`validate_project` is what the in-container deploy calls before it generates a
single stub: a manifest key that does not exist, a port written as a string or
an argument annotated with a type the stub cannot import is a failure with a
file and a line, not a warning followed by a build.
"""

import glob
import os

import yaml

from canyonos_core.schema.agent_yaml import (
    BUILTIN_TYPE_NAMES,
    AgentDeclaration,
    ArgumentDecl,
    FunctionDecl,
    ReturnsDecl,
    load_agent_declaration,
)
from canyonos_core.schema.errors import (
    DependencyPinConflict,
    SchemaError,
    SchemaViolation,
    render_violation,
)
from canyonos_core.schema.manifest import (
    AgentService,
    DatabaseService,
    DatabaseSpec,
    Ec2Spec,
    Manifest,
    OtelDestination,
    OtelSpec,
    RedisSpec,
    Resources,
    WorkflowService,
    load_manifest,
)

__all__ = [
    "AgentDeclaration",
    "AgentService",
    "ArgumentDecl",
    "BUILTIN_TYPE_NAMES",
    "DatabaseService",
    "DatabaseSpec",
    "DependencyPinConflict",
    "Ec2Spec",
    "FunctionDecl",
    "Manifest",
    "OtelDestination",
    "OtelSpec",
    "RedisSpec",
    "Resources",
    "ReturnsDecl",
    "SchemaError",
    "SchemaViolation",
    "WorkflowService",
    "load_agent_declaration",
    "load_manifest",
    "render_violation",
    "validate_project",
]


def _declared_name(path):
    """The `agent.name` a YAML in the declarations directory claims, if any.

    Returns None for a file that is not an agent declaration at all: the
    directory also holds the manifest itself under the .car layout, and the
    build skips those the same way.
    """
    try:
        with open(path, "r", encoding="utf-8") as f:
            document = yaml.safe_load(f)
    except (OSError, yaml.YAMLError):
        # A file that will not parse is reported by load_agent_declaration.
        return ""
    if not isinstance(document, dict) or "agent" not in document:
        return None
    block = document["agent"]
    name = block.get("name") if isinstance(block, dict) else None
    return name if isinstance(name, str) else ""


def validate_project(manifest_path, declarations_dir):
    """Every violation in a project's manifest and agent declarations.

    Never raises: the caller decides how to report. The manifest and the
    declarations are checked independently so one broken file does not hide
    the others; only the last step, binding each agent to the declaration that
    names it, needs a manifest that parsed.
    """
    manifest = None
    violations = []
    try:
        manifest = load_manifest(manifest_path)
    except SchemaError as error:
        violations.extend(error.violations)

    declared = set()
    for path in sorted(glob.glob(os.path.join(declarations_dir, "*.yaml"))):
        name = _declared_name(path)
        if name is None:
            continue
        # A declaration that fails its own checks still claims its name, so the
        # agent it belongs to is not also reported as having none.
        declared.add(name)
        try:
            declaration = load_agent_declaration(path)
        except SchemaError as error:
            violations.extend(error.violations)
            continue
        declared.add(declaration.name)

    if manifest is None:
        return tuple(violations)

    for index, service in enumerate(manifest.agents):
        if service.type != "agent" or service.name in declared:
            continue
        violations.append(
            SchemaViolation(
                manifest_path,
                0,
                f"agents[{index}].name",
                f"no agent declaration in {declarations_dir} sets "
                f"agent.name: {service.name}; the stub cannot be generated",
            )
        )
    return tuple(violations)
