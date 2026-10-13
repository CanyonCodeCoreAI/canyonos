"""The agent functions schema: the `functions` a stub is generated from.

The stub generator builds from an agent entry's `functions`, so every name
here becomes Python source: the agent is a class, each function a method
and each argument a parameter. An argument's `type` becomes its annotation,
and the stub imports nothing, so a type may only be built from builtins.
"""

import ast
import builtins
import keyword
from dataclasses import dataclass

from canyonos_core.schema._checks import (
    _check_keys,
    _describe,
    _field,
    _string,
)

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

_BUILTIN_TYPES = {name: getattr(builtins, name) for name in BUILTIN_TYPE_NAMES}

# Nodes an annotation may be built from: `list[str]`, `dict[str, int]`,
# `tuple[int, ...]`, `int | None`.
_ANNOTATION_NODES = (
    ast.Expression,
    ast.Name,
    ast.Load,
    ast.Subscript,
    ast.Tuple,
    ast.BinOp,
    ast.BitOr,
)

# Module-level names every generated method body reads; an agent class or an
# argument by one of these names would shadow it.
STUB_GLOBAL_NAMES = frozenset({"Future", "inspect", "isinstance"})

_FUNCTION_KEYS = frozenset({"name", "arguments", "returns"})
_ARGUMENT_KEYS = frozenset({"name", "type"})
_RETURNS_KEYS = frozenset({"type"})


@dataclass(frozen=True)
class ArgumentDecl:
    """One argument of a function declared for an agent."""

    name: str
    type: str | None = None


@dataclass(frozen=True)
class ReturnsDecl:
    """The optional return type of a function declared for an agent."""

    type: str | None = None


@dataclass(frozen=True)
class FunctionDecl:
    """One function declared for an agent; becomes a method on its stub."""

    name: str
    arguments: tuple = ()
    returns: ReturnsDecl | None = None


def _is_builtin_annotation(type_name):
    """True when `type_name` evaluates with nothing imported."""
    # A type nested or chained deeply enough overflows the parser or the
    # compiler; the stub would fail the same way, so it is not a builtin type.
    try:
        tree = ast.parse(type_name, mode="eval")
    except (SyntaxError, RecursionError):
        return False
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant):
            if node.value is not None and node.value is not Ellipsis:
                return False
        elif not isinstance(node, _ANNOTATION_NODES):
            return False
        elif isinstance(node, ast.Name) and node.id not in BUILTIN_TYPE_NAMES:
            return False
    # Only builtin type names reach here, so evaluating is safe; it rejects
    # what parses but fails when the stub's `def` runs, such as `int[str]`.
    try:
        eval(compile(tree, "<annotation>", "eval"), {"__builtins__": _BUILTIN_TYPES})
    except (TypeError, RecursionError):
        return False
    return True


def _annotation(collector, node, prefix, what):
    """The `type` of an argument or a return, or None when absent or unusable."""
    type_name = _string(collector, node, "type", prefix)
    if type_name is None or _is_builtin_annotation(type_name):
        return type_name
    shown = type_name if len(type_name) <= 80 else type_name[:77] + "..."
    collector.add(
        node,
        "type",
        _field(prefix, "type"),
        f"{shown!r} is not built from builtin types; the generated stub "
        f"imports nothing, so {what} type may only use "
        f"{', '.join(sorted(BUILTIN_TYPE_NAMES))} and None",
    )
    return None


def _identifier(collector, node, key, prefix, required=False, reserved=()):
    """A name the generated stub writes as Python source."""
    value = _string(collector, node, key, prefix, required=required)
    if value is None:
        return None
    if not value.isidentifier() or keyword.iskeyword(value):
        collector.add(
            node,
            key,
            _field(prefix, key),
            f"{value!r} is not a valid Python identifier; the generated stub "
            "uses it as a name",
        )
        return None
    if value in reserved:
        collector.add(
            node,
            key,
            _field(prefix, key),
            f"{value!r} would shadow the name the generated stub uses for "
            "itself; choose another",
        )
        return None
    return value


def _returns(collector, node, prefix):
    """Parse a function's `returns` block, recording violations if malformed."""
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
        type=_annotation(collector, block, _field(prefix, "returns"), "a return")
    )


def _arguments(collector, node, prefix):
    """Parse a function's `arguments`, recording violations for duplicate names and
    types the generated stub can't use."""
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
    seen = set()
    for index, entry in enumerate(raw):
        argument_prefix = f"{prefix}.arguments[{index}]"
        if not isinstance(entry, dict):
            collector.add(
                raw,
                index,
                argument_prefix,
                f"expected a mapping, got {_describe(entry)}",
            )
            continue
        _check_keys(collector, entry, argument_prefix, _ARGUMENT_KEYS)
        name = _identifier(
            collector,
            entry,
            "name",
            argument_prefix,
            required=True,
            reserved=STUB_GLOBAL_NAMES,
        )
        if name == "self" or name in seen:
            collector.add(
                entry,
                "name",
                _field(argument_prefix, "name"),
                f"{name!r} is already a parameter of the generated method",
            )
            name = None
        type_name = _annotation(collector, entry, argument_prefix, "an argument")
        if name:
            seen.add(name)
            arguments.append(ArgumentDecl(name=name, type=type_name))
    return tuple(arguments)


def _function_name(collector, entry, prefix, seen):
    """The method name a function gets on the stub, or None when it would break
    the class it is written into."""
    name = _identifier(collector, entry, "name", prefix, required=True)
    if name is None:
        return None
    if name in BUILTIN_TYPE_NAMES:
        message = (
            f"{name!r} would shadow the builtin type inside the generated class, "
            "breaking every annotation after it; choose another"
        )
    elif name.startswith("__") and name.endswith("__"):
        message = f"{name!r} is reserved for Python; choose another"
    elif name in seen:
        message = f"{name!r} is already a function of this agent"
    else:
        return name
    collector.add(entry, "name", _field(prefix, "name"), message)
    return None


def _functions(collector, node, parent):
    """Parse the agent's `functions` list, recording violations and skipping any entry
    that can't be read. An agent may declare none: its stub is then a bare class."""
    raw = node.get("functions")
    if raw is None:
        return ()
    if not isinstance(raw, list):
        collector.add(
            node,
            "functions",
            _field(parent, "functions"),
            f"expected a list of functions, got {_describe(raw)}",
        )
        return ()

    functions = []
    seen = set()
    for index, entry in enumerate(raw):
        prefix = f"{parent}.functions[{index}]"
        if not isinstance(entry, dict):
            collector.add(
                raw, index, prefix, f"expected a mapping, got {_describe(entry)}"
            )
            continue
        _check_keys(collector, entry, prefix, _FUNCTION_KEYS)
        name = _function_name(collector, entry, prefix, seen)
        arguments = _arguments(collector, entry, prefix)
        returns = _returns(collector, entry, prefix)
        if name:
            seen.add(name)
            functions.append(
                FunctionDecl(
                    name=name,
                    arguments=arguments,
                    returns=returns,
                )
            )
    return tuple(functions)
