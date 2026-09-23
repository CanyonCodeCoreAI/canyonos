"""Field readers shared by the manifest and the agent declaration schemas.

Each reader takes the mapping a key lives in, records a violation when the
value is not what the schema declares, and hands back the declared default so
checking carries on and the caller sees every problem at once.

`${VAR}` references are expanded on the way through, but only string-typed
fields support them: the Global Controller's expansion produces text, so a
reference in a numeric or boolean field would reach the runtime as a string
and be silently misread (a `replicas` of `"3"` starts one replica). Those are
rejected here instead.
"""

import difflib
import math

from canyonos_core.controller.utils.config_env import ENV_REF, expand_env_value
from canyonos_core.schema.errors import SchemaViolation
from canyonos_core.schema.yaml_lines import line_of

_ENV_REF_HINT = " (environment references are only supported in string fields)"


class _Collector:
    """Accumulates every violation in one file instead of stopping at the first."""

    def __init__(self, path):
        self.path = path
        self.violations = []

    def add(self, node, key, field_name, message):
        self.violations.append(
            SchemaViolation(self.path, line_of(node, key), field_name, message)
        )


def _field(prefix, key):
    return f"{prefix}.{key}" if prefix else str(key)


def _describe(value):
    """Quote a value and name its kind, so the message shows what was written."""
    if value is None:
        return "nothing"
    if isinstance(value, bool):
        return f"the boolean {str(value).lower()}"
    if isinstance(value, (int, float)):
        return f"the number {value!r}"
    if isinstance(value, str):
        return f"the string {value!r}"
    if isinstance(value, list):
        return f"the list {value!r}"
    if isinstance(value, dict):
        return "a mapping"
    return f"{value!r}"


def _resolve(raw):
    """Expand `${VAR}` refs in a scalar. An unset variable is left literal,
    which is what the Global Controller does with it too."""
    if not isinstance(raw, str):
        return raw
    return expand_env_value(raw)


def _describe_rejected(raw, value):
    """How to name a rejected value, as the reference it was written as if it is one.

    An expansion can hide what the author typed -- an empty variable reads back
    as `''` -- so the message quotes the reference instead.
    """
    if isinstance(raw, str) and ENV_REF.search(raw):
        return f"{raw!r}{_ENV_REF_HINT}"
    return _describe(value)


def _unknown_key_message(key, allowed):
    message = f"unknown key {key!r}"
    close = difflib.get_close_matches(str(key), sorted(allowed), n=1)
    if close:
        message += f" (did you mean {close[0]!r}?)"
    return message


def _check_keys(collector, node, prefix, allowed):
    """Report every key in `node` the schema does not declare."""
    for key in node:
        if key in allowed:
            continue
        collector.add(
            node, key, _field(prefix, key), _unknown_key_message(key, allowed)
        )


def _mapping(collector, node, key, prefix, allowed):
    """Return the mapping at `key`, or None when it is absent or not a mapping."""
    if key not in node or node[key] is None:
        return None
    value = node[key]
    if not isinstance(value, dict):
        collector.add(
            node,
            key,
            _field(prefix, key),
            f"expected a mapping, got {_describe(value)}",
        )
        return None
    _check_keys(collector, value, _field(prefix, key), allowed)
    return value


def _integer(collector, node, key, prefix, default, minimum=None, maximum=None):
    if key not in node:
        return default
    raw = node[key]
    value = _resolve(raw)
    if minimum is not None and maximum is not None:
        bound = f" between {minimum} and {maximum}"
    elif minimum is not None:
        bound = f" >= {minimum}"
    else:
        bound = ""
    wrong_type = isinstance(value, bool) or not isinstance(value, int)
    out_of_range = not wrong_type and (
        (minimum is not None and value < minimum)
        or (maximum is not None and value > maximum)
    )
    if wrong_type or out_of_range:
        collector.add(
            node,
            key,
            _field(prefix, key),
            f"expected an integer{bound}, got {_describe_rejected(raw, value)}",
        )
        return default
    return value


def _port(collector, node, key, prefix, default):
    """A TCP port: an integer from 1 to 65535."""
    return _integer(collector, node, key, prefix, default, 1, 65535)


def _as_finite_float(value):
    """`value` as a finite float, or None.

    YAML spells infinity and NaN as `.inf` and `.nan`, and an integer too large
    for a float raises OverflowError on conversion; none of them is a number
    any field here can use.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        number = float(value)
    except OverflowError:
        return None
    return number if math.isfinite(number) else None


def _number(collector, node, key, prefix, default, minimum=None):
    """A field that accepts a fraction, unlike the integer counts and ports."""
    if key not in node:
        return default
    raw = node[key]
    value = _resolve(raw)
    bound = f" > {minimum}" if minimum is not None else ""
    number = _as_finite_float(value)
    if number is None or (minimum is not None and number <= minimum):
        collector.add(
            node,
            key,
            _field(prefix, key),
            f"expected a finite number{bound}, got {_describe_rejected(raw, value)}",
        )
        return default
    return number


def _unset_reference(value):
    """True when expansion left a `${VAR}` in place because VAR is not set."""
    return isinstance(value, str) and ENV_REF.search(value) is not None


def _unset_message(raw):
    return f"{raw!r} names an environment variable that is not set"


def _string(collector, node, key, prefix, default=None, required=False):
    if key not in node or node[key] is None:
        if required:
            collector.add(node, key, _field(prefix, key), "is required but missing")
        return default
    raw = node[key]
    value = _resolve(raw)
    if required and _unset_reference(value):
        collector.add(node, key, _field(prefix, key), _unset_message(raw))
        return default
    if not isinstance(value, str) or not value.strip():
        collector.add(
            node,
            key,
            _field(prefix, key),
            f"expected a non-empty string, got {_describe_rejected(raw, value)}",
        )
        return default
    return value


def _boolean(collector, node, key, prefix, default):
    if key not in node:
        return default
    raw = node[key]
    value = _resolve(raw)
    if not isinstance(value, bool):
        collector.add(
            node,
            key,
            _field(prefix, key),
            f"expected a boolean, got {_describe_rejected(raw, value)}",
        )
        return default
    return value


def _string_list(collector, node, key, prefix, required=False):
    if key not in node or node[key] is None:
        if required:
            collector.add(node, key, _field(prefix, key), "is required but missing")
        return ()
    value = node[key]
    if not isinstance(value, list):
        collector.add(
            node,
            key,
            _field(prefix, key),
            f"expected a list of strings, got {_describe(value)}",
        )
        return ()
    if required and not value:
        # A required list is required to say something; `[]` is as missing as
        # no key at all.
        collector.add(
            node, key, _field(prefix, key), "is required and must not be empty"
        )
        return ()
    items = [_resolve(item) for item in value]
    for index, (raw, item) in enumerate(zip(value, items)):
        if required and _unset_reference(item):
            collector.add(value, index, _field(prefix, key), _unset_message(raw))
            return ()
        if isinstance(item, str) and item.strip():
            continue
        collector.add(
            value,
            index,
            _field(prefix, key),
            f"expected a list of strings, got {_describe_rejected(raw, item)}",
        )
        return ()
    return tuple(items)


def _string_mapping(collector, node, key, prefix):
    if key not in node or node[key] is None:
        return {}
    value = node[key]
    if not isinstance(value, dict):
        collector.add(
            node,
            key,
            _field(prefix, key),
            f"expected a mapping, got {_describe(value)}",
        )
        return {}
    resolved = {}
    for name, item in value.items():
        item = _resolve(item)
        if not isinstance(name, str) or not isinstance(item, (str, int, float)):
            collector.add(
                node,
                key,
                _field(prefix, key),
                f"expected a mapping of strings to strings, got {_describe(value)}",
            )
            return {}
        resolved[name] = str(item)
    return resolved
