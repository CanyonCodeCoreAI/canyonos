"""The `otel.destinations` contract, shared by the manifest schema and the exporter.

The Global Controller hands the list to the exporter as written, after `${VAR}`
expansion, so the schema that gates a deploy and the exporter that reads the
list at runtime check it with these same rules.
"""

import math

SUPPORTED_PROTOCOLS = ("grpc", "http", "http/protobuf")
DESTINATION_KEYS = frozenset(
    {"name", "protocol", "endpoint", "headers", "insecure", "timeout"}
)


def normalize_protocol(protocol):
    """Protocols are matched in any casing."""
    return protocol.lower() if isinstance(protocol, str) else protocol


def _non_empty_string(value):
    return isinstance(value, str) and bool(value.strip())


def destinations_problem(destinations):
    """Why the destinations value as a whole is unusable, or None."""
    if not isinstance(destinations, list) or not destinations:
        return "must be a non-empty list"
    return None


def destination_problems(destination):
    """Yield `(key, message)` for every rule one destination mapping breaks."""
    if not _non_empty_string(destination.get("name")):
        yield "name", "name must be a non-empty string"

    protocol = destination.get("protocol")
    if normalize_protocol(protocol) not in SUPPORTED_PROTOCOLS:
        yield (
            "protocol",
            f"protocol must be one of {list(SUPPORTED_PROTOCOLS)}; got {protocol!r}",
        )

    if not _non_empty_string(destination.get("endpoint")):
        yield "endpoint", "endpoint must be a non-empty string"

    headers = destination.get("headers")
    if headers is not None:
        if not isinstance(headers, dict):
            yield "headers", "headers must be a mapping"
        elif any(
            not _non_empty_string(key) or not isinstance(value, str)
            for key, value in headers.items()
        ):
            yield "headers", "headers must map non-empty strings to strings"

    insecure = destination.get("insecure")
    if insecure is not None and not isinstance(insecure, bool):
        yield "insecure", "insecure must be a boolean"

    timeout = destination.get("timeout")
    if timeout is not None and _positive_number(timeout) is None:
        yield "timeout", "timeout must be a positive number"


def _positive_number(value):
    """`value` as a finite float above zero, or None."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        number = float(value)
    except OverflowError:
        return None
    return number if math.isfinite(number) and number > 0 else None


def normalize_destination(destination):
    """A destination that passed `destination_problems`, in the form the exporter uses."""
    headers = destination.get("headers")
    timeout = destination.get("timeout")
    return {
        "name": destination["name"].strip(),
        "protocol": normalize_protocol(destination["protocol"]),
        "endpoint": destination["endpoint"].strip(),
        "headers": dict(headers) if headers is not None else None,
        "insecure": destination.get("insecure"),
        "timeout": float(timeout) if timeout is not None else None,
    }


def duplicate_name_message(name):
    return f"destination names must be unique; duplicate {name!r}"
