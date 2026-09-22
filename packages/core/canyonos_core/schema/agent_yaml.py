"""The agent declaration schema: the YAML a stub is generated from.

An argument's `type` is pasted verbatim into the generated stub as an
annotation, and the stub imports nothing, so anything but a builtin type name
produces a module that fails to import inside the container.
"""

from dataclasses import dataclass

import yaml

from canyonos_core.schema._checks import (
    _check_keys,
    _Collector,
    _describe,
    _field,
    _string,
)
from canyonos_core.schema.errors import SchemaError, SchemaViolation
from canyonos_core.schema.yaml_lines import line_of, load_yaml_lines, parse_failure

# Names the generated stub can annotate with, given it imports nothing.
BUILTIN_TYPE_NAMES = frozenset(
    {
        "bool",
        "bytearray",
        "bytes",
        "complex",
        "dict",
        "float",
        "frozenset",
        "int",
        "list",
        "object",
        "set",
        "str",
        "tuple",
    }
)

_DOCUMENT_KEYS = frozenset({"agent"})
_DECLARATION_KEYS = frozenset({"name", "functions"})
_FUNCTION_KEYS = frozenset({"name", "description", "arguments", "returns"})
_ARGUMENT_KEYS = frozenset({"name", "type"})
_RETURNS_KEYS = frozenset({"type"})


@dataclass(frozen=True)
class ArgumentDecl:
    name: str
    type: str | None = None


@dataclass(frozen=True)
class ReturnsDecl:
    type: str | None = None


@dataclass(frozen=True)
class FunctionDecl:
    name: str
    description: str = ""
    arguments: tuple = ()
    returns: ReturnsDecl | None = None


@dataclass(frozen=True)
class AgentDeclaration:
    name: str
    functions: tuple = ()
    path: str = ""


def _returns(collector, node, prefix):
    if node.get("returns") is None:
        return None
    block = node["returns"]
    if not isinstance(block, dict):
        collector.add(
            node,
            "returns",
            _field(prefix, "returns"),
            f"expected a mapping, got {_describe(block)}",
        )
        return None
    _check_keys(collector, block, _field(prefix, "returns"), _RETURNS_KEYS)
    return ReturnsDecl(
        type=_string(collector, block, "type", _field(prefix, "returns"))
    )


def _arguments(collector, node, prefix):
    raw = node.get("arguments")
    if raw is None:
        return ()
    if not isinstance(raw, list):
        collector.add(
            node,
            "arguments",
            _field(prefix, "arguments"),
            f"expected a list of arguments, got {_describe(raw)}",
        )
        return ()

    arguments = []
    for index, entry in enumerate(raw):
        argument_prefix = f"{prefix}.arguments[{index}]"
        if not isinstance(entry, dict):
            collector.add(
                node,
                "arguments",
                argument_prefix,
                f"expected a mapping, got {_describe(entry)}",
            )
            continue
        _check_keys(collector, entry, argument_prefix, _ARGUMENT_KEYS)
        name = _string(collector, entry, "name", argument_prefix, required=True)
        type_name = _string(collector, entry, "type", argument_prefix)
        if type_name is not None and type_name not in BUILTIN_TYPE_NAMES:
            collector.add(
                entry,
                "type",
                _field(argument_prefix, "type"),
                f"{type_name!r} is not a builtin type; the generated stub imports "
                "nothing, so an argument type must be one of "
                f"{', '.join(sorted(BUILTIN_TYPE_NAMES))}",
            )
            type_name = None
        if name:
            arguments.append(ArgumentDecl(name=name, type=type_name))
    return tuple(arguments)


def _functions(collector, node):
    raw = node.get("functions")
    if raw is None:
        return ()
    if not isinstance(raw, list):
        collector.add(
            node,
            "functions",
            "agent.functions",
            f"expected a list of functions, got {_describe(raw)}",
        )
        return ()

    functions = []
    for index, entry in enumerate(raw):
        prefix = f"agent.functions[{index}]"
        if not isinstance(entry, dict):
            collector.add(
                node, "functions", prefix, f"expected a mapping, got {_describe(entry)}"
            )
            continue
        _check_keys(collector, entry, prefix, _FUNCTION_KEYS)
        name = _string(collector, entry, "name", prefix, required=True)
        description = entry.get("description")
        if description is not None and not isinstance(description, str):
            collector.add(
                entry,
                "description",
                _field(prefix, "description"),
                f"expected a string, got {_describe(description)}",
            )
            description = None
        arguments = _arguments(collector, entry, prefix)
        returns = _returns(collector, entry, prefix)
        if name:
            functions.append(
                FunctionDecl(
                    name=name,
                    description=description or "",
                    arguments=arguments,
                    returns=returns,
                )
            )
    return tuple(functions)


def load_agent_declaration(path):
    """Parse and check one agent YAML, reporting every problem at once.

    Raises:
        SchemaError: the declaration is unusable; `.violations` holds them all.
    """
    collector = _Collector(path)
    try:
        document = load_yaml_lines(path)
    except OSError as exc:
        raise SchemaError(
            [SchemaViolation(path, 0, "", f"cannot be read: {exc}")]
        ) from exc
    except yaml.YAMLError as exc:
        line, detail = parse_failure(exc)
        raise SchemaError(
            [SchemaViolation(path, line, "", f"is not valid YAML: {detail}")]
        ) from exc

    if not isinstance(document, dict):
        raise SchemaError(
            [
                SchemaViolation(
                    path, 0, "", f"expected a mapping, got {_describe(document)}"
                )
            ]
        )

    _check_keys(collector, document, "", _DOCUMENT_KEYS)
    block = document.get("agent")
    if not isinstance(block, dict):
        collector.violations.append(
            SchemaViolation(
                path,
                line_of(document, "agent"),
                "agent",
                f"is required and must be a mapping, got {_describe(block)}",
            )
        )
        raise SchemaError(collector.violations)

    _check_keys(collector, block, "agent", _DECLARATION_KEYS)
    name = _string(collector, block, "name", "agent", required=True)
    functions = _functions(collector, block)
    if collector.violations:
        raise SchemaError(collector.violations)
    return AgentDeclaration(name=name or "", functions=functions, path=path)
