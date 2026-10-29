# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""The manifest schema: every key `global_controller.yaml` may carry.

Anything not declared here is rejected, so a typo fails the deploy with a line
number instead of being silently ignored, and a wrong type fails here rather
than deep inside the provisioner once containers are already up.
"""

import ntpath
import posixpath
from dataclasses import dataclass, field
from typing import ClassVar

import yaml
from packaging.requirements import InvalidRequirement, Requirement

from canyonos_core.controller.utils.config_env import (
    ENV_REF,
    expand_env_value,
    load_root_dotenv,
)
from canyonos_core.endpoint import ENDPOINT_AGENT_NAME
from canyonos_core.reconciler import providers
from canyonos_core.schema._checks import (
    _counts,
    _ENV_REF_HINT,
    _boolean,
    _check_keys,
    _Collector,
    _describe,
    _field,
    _integer,
    _mapping,
    _number,
    _port,
    _resolve,
    _string,
    _string_list,
    _string_mapping,
    _unknown_key_message,
    _unset_message,
    _unset_reference,
)
from canyonos_core.schema.errors import SchemaError, SchemaViolation
from canyonos_core.schema.kubernetes_block import KubernetesSpec, parse_kubernetes
from canyonos_core.schema.functions import STUB_GLOBAL_NAMES, _functions, _identifier
from canyonos_core.schema.otel_destinations import (
    DESTINATION_KEYS,
    destination_problems,
    destinations_problem,
    duplicate_name_message,
    normalize_destination,
)
from canyonos_core.schema.yaml_lines import load_yaml_lines, parse_failure

AGENT_TYPES = ("agent", "database")

# Keys every entry in `agents` may carry, whatever its type.
_COMMON_AGENT_KEYS = frozenset(
    {
        "name",
        "type",
        "replicas",
        "resources",
        "stateful",
        "env",
    }
)
_CODE_AGENT_KEYS = _COMMON_AGENT_KEYS | {"entrypoint", "requirements", "functions"}
_DATABASE_KEYS = _COMMON_AGENT_KEYS | {"image", "db_port", "volume_path"}
_ALL_AGENT_KEYS = _CODE_AGENT_KEYS | _DATABASE_KEYS
_AGENT_KEYS_BY_TYPE = {
    "agent": _CODE_AGENT_KEYS,
    "database": _DATABASE_KEYS,
}

_MANIFEST_KEYS = frozenset(
    {
        "provider",
        "agents",
        "poll_interval",
        "cleanup_interval",
        "project_id",
        "redis",
        "logs",
        "otel",
        "ssh_private_key_path",
        *(schema.SECTION for schema in providers.SCHEMAS.values() if schema.SECTION),
        "endpoint",
        "dashboard_port",
        "kubernetes",
    }
)
_ENDPOINT_KEYS = frozenset({"api_port", "agent", "method"})
_REDIS_KEYS = frozenset({"host", "port", "db"})
# Keys that used to mean something and now do nothing, each with the message
# that tells a user carrying one what to do instead.
_RETIRED_KEYS = {
    "database": "is no longer used; telemetry is configured under otel: -- remove it",
    "env_file": "is no longer used; the `.env` in the project folder reaches the "
    "agent replicas by itself -- remove it",
}
_OTEL_KEYS = frozenset({"destinations"})
_RESOURCE_KEYS = frozenset({"cpu", "memory", "gpu"})


# ------------------------------------------------------------------ #
#  Parsed shapes                                                       #
# ------------------------------------------------------------------ #


@dataclass(frozen=True)
class Resources:
    """The compute resources requested for an agent in `global_controller.yaml`."""

    cpu: float = 1
    memory: float = 512
    gpu: int | None = None


@dataclass(frozen=True)
class RedisSpec:
    """The `redis` section of `global_controller.yaml`: where the project Redis runs."""

    host: str = "localhost"
    port: int = 6379
    db: int = 0


@dataclass(frozen=True)
class OtelDestination:
    """One `otel` destination in `global_controller.yaml`: where to send telemetry."""

    name: str
    protocol: str
    endpoint: str
    headers: dict = field(default_factory=dict)
    insecure: bool = False
    timeout: float | None = None


@dataclass(frozen=True)
class OtelSpec:
    """The `otel` section of `global_controller.yaml`."""

    destinations: tuple = ()


@dataclass(frozen=True)
class EndpointSpec:
    """The managed HTTP endpoint configuration: the agent method it serves."""

    agent: str
    method: str
    api_port: int | None = None


@dataclass(frozen=True)
class _Agent:
    """Fields shared by every entry in `agents`."""

    name: str
    replicas: int = 1
    resources: Resources = field(default_factory=Resources)
    stateful: bool = False
    env: dict = field(default_factory=dict)

    type: ClassVar[str] = "agent"


@dataclass(frozen=True)
class CodeAgent(_Agent):
    """An `agents:` entry of type `agent`: a Python agent class."""

    entrypoint: str = ""
    requirements: tuple = ()
    requirement_lines: tuple = field(default=(), compare=False, repr=False)
    functions: tuple = ()

    type: ClassVar[str] = "agent"


@dataclass(frozen=True)
class DatabaseAgent(_Agent):
    """An `agents:` entry of type `database`: a stock database image."""

    image: str = ""
    db_port: int = 5432
    volume_path: str | None = None

    type: ClassVar[str] = "database"


@dataclass(frozen=True)
class Manifest:
    """The project's `global_controller.yaml`, checked and parsed by `load_manifest`."""

    agents: tuple
    provider: str = providers.DEFAULT
    poll_interval: float = 5
    cleanup_interval: float = 10
    project_id: str | None = None
    redis: RedisSpec = field(default_factory=RedisSpec)
    # Streams failure and log detail into each future; read as `config.get("logs", True)`, hence the default.
    logs: bool = True
    otel: OtelSpec | None = None
    endpoint: EndpointSpec | None = None
    dashboard_port: int = 8081
    # Read only by `canyonos deploy --target kubernetes`.
    kubernetes: KubernetesSpec | None = None
    path: str = ""


# ------------------------------------------------------------------ #
#  Reading and checking                                                #
# ------------------------------------------------------------------ #


def _is_rooted(path):
    """True for a path anchored anywhere but the project, on either OS.

    `posixpath` alone takes `\\outside\\agent.py`, `C:\\x` and
    `\\\\server\\share` for relative names. The leading-backslash test is
    explicit because newer Pythons no longer call a drive-relative `\\x`
    absolute.
    """
    return (
        posixpath.isabs(path)
        or ntpath.isabs(path)
        or path.startswith("\\")
        or (len(path) > 1 and path[1] == ":")
    )


def _project_relative_py(collector, node, key, prefix, required):
    """A source path inside the project: relative, no `..`, ending in `.py`."""
    value = _string(collector, node, key, prefix, required=required)
    if value is None:
        return ""
    field_name = _field(prefix, key)
    if _is_rooted(value):
        collector.add(
            node, key, field_name, f"must be relative to the project, got {value!r}"
        )
        return ""
    if ".." in value.replace("\\", "/").split("/"):
        collector.add(
            node,
            key,
            field_name,
            f"must not escape the project with '..', got {value!r}",
        )
        return ""
    if not value.endswith(".py"):
        collector.add(node, key, field_name, f"must name a .py file, got {value!r}")
        return ""
    return value


def _item_lines(node, key):
    return tuple(getattr(node.get(key), "item_lines", ()))


def _requirements(collector, node, prefix):
    """Each entry must be one PEP 508 requirement, the form the pin check reads.

    requirements.txt takes the entries verbatim, so an option line such as
    `-r deps.txt` or two requirements in one entry installed packages the
    platform pin check never saw.
    """
    requirements = _string_list(collector, node, "requirements", prefix)
    for index, requirement in enumerate(requirements):
        try:
            Requirement(requirement)
        except InvalidRequirement:
            collector.add(
                node["requirements"],
                index,
                f"{_field(prefix, 'requirements')}[{index}]",
                f"{requirement!r} is not a single PEP 508 requirement; write one "
                "package per entry, and a URL as `name @ url`",
            )
            return ()
    return requirements


def _resources(collector, node, prefix):
    block = _mapping(collector, node, "resources", prefix, _RESOURCE_KEYS)
    if block is None:
        return Resources()
    prefix = _field(prefix, "resources")
    gpu = None
    if "gpu" in block:
        # 0 is "no GPU", which is what the CLI's resource picker writes by default.
        gpu = _integer(collector, block, "gpu", prefix, None, 0)
    return Resources(
        cpu=_number(collector, block, "cpu", prefix, 1, 0),
        memory=_number(collector, block, "memory", prefix, 512, 0),
        gpu=gpu,
    )


def _agent_type(collector, node, prefix):
    if "type" not in node:
        return "agent"
    value = _resolve(node["type"])
    if value not in AGENT_TYPES:
        collector.add(
            node,
            "type",
            _field(prefix, "type"),
            f"expected one of {list(AGENT_TYPES)}, got {_describe(value)}",
        )
        return None
    return value


def _provider(collector, node, prefix):
    """The provider in any casing, normalized to the spelling records store."""
    if "provider" not in node:
        return providers.DEFAULT
    value = _resolve(node["provider"])
    try:
        return providers.canonical_name(value)
    except ValueError:
        collector.add(
            node,
            "provider",
            _field(prefix, "provider"),
            f"expected one of {list(providers.NAMES)}, got {_describe(value)}",
        )
        return providers.DEFAULT


def _agent(collector, entries, index):
    """Parse one entry of `agents`, or None when it cannot be identified.

    A type or name that is wrong still leaves the rest of the entry checked,
    so every problem in it is reported at once.
    """
    node = entries[index]
    prefix = f"agents[{index}]"
    if not isinstance(node, dict):
        collector.add(
            entries, index, prefix, f"expected a mapping, got {_describe(node)}"
        )
        return None

    agent_type = _agent_type(collector, node, prefix)
    _check_agent_keys(collector, node, prefix, agent_type)

    name = (
        _identifier(
            collector, node, "name", prefix, required=True, reserved=STUB_GLOBAL_NAMES
        )
        if agent_type == "agent"
        else _string(collector, node, "name", prefix, required=True)
    )
    common = {
        "name": name,
        "replicas": _integer(collector, node, "replicas", prefix, 1, 1),
        "resources": _resources(collector, node, prefix),
        "stateful": _boolean(collector, node, "stateful", prefix, False),
        "env": _string_mapping(collector, node, "env", prefix),
    }
    if agent_type == "database":
        if common["replicas"] != 1:
            collector.add(
                node,
                "replicas",
                _field(prefix, "replicas"),
                f"a database runs as a single container, got {_describe(node['replicas'])}",
            )
        agent_class = DatabaseAgent
        fields = {
            "image": _string(collector, node, "image", prefix, "", required=True) or "",
            "db_port": _port(collector, node, "db_port", prefix, 5432),
            "volume_path": _string(collector, node, "volume_path", prefix),
        }
    elif agent_type == "agent":
        agent_class = CodeAgent
        fields = {
            "entrypoint": _project_relative_py(
                collector, node, "entrypoint", prefix, required=True
            ),
            "requirements": _requirements(collector, node, prefix),
            "requirement_lines": _item_lines(node, "requirements"),
            "functions": _functions(collector, node, prefix),
        }
    else:
        return None

    if name is None:
        return None
    return agent_class(**common, **fields)


def _check_agent_keys(collector, node, prefix, agent_type):
    allowed = _AGENT_KEYS_BY_TYPE.get(agent_type, _ALL_AGENT_KEYS)
    for key in node:
        if key in allowed:
            continue
        if key in _ALL_AGENT_KEYS:
            message = f"key {key!r} is not valid for type {agent_type!r}"
        else:
            message = _unknown_key_message(key, allowed)
        collector.add(node, key, _field(prefix, key), message)


def _agents(collector, node):
    """Parse the `agents` list in `global_controller.yaml`; two names that differ only
    in case are a violation, since both would get the same image and container name,
    and so is `endpoint`, the name of the HTTP endpoint's own replica."""
    if "agents" not in node or node["agents"] is None:
        collector.add(node, "agents", "agents", "is required but missing")
        return ()
    raw = node["agents"]
    if not isinstance(raw, list):
        collector.add(
            node,
            "agents",
            "agents",
            f"expected a list of agents, got {_describe(raw)}",
        )
        return ()

    parsed = []
    for index, entry in enumerate(raw):
        agent_spec = _agent(collector, raw, index)
        if agent_spec is not None:
            parsed.append((index, entry, agent_spec))

    # Two agents whose names differ only in case collide: the image tag and
    # the container name are both built from `name.lower()`.
    seen = {}
    for index, entry, agent_spec in parsed:
        key = agent_spec.name.lower()
        if key == ENDPOINT_AGENT_NAME:
            collector.add(
                entry,
                "name",
                f"agents[{index}].name",
                f"{agent_spec.name!r} is reserved for the HTTP endpoint container; "
                "rename this agent",
            )
        elif key in seen:
            collector.add(
                entry,
                "name",
                f"agents[{index}].name",
                f"duplicate agent name {agent_spec.name!r}: agents[{seen[key]}] "
                "already claims it (names are lowercased into one image tag)",
            )
        else:
            seen[key] = index
    return tuple(agent_spec for _, _, agent_spec in parsed)


def _otel(collector, node):
    """Parse the `otel` section of `global_controller.yaml`, recording violations for
    bad or duplicate destinations."""
    block = _mapping(collector, node, "otel", "", _OTEL_KEYS)
    if block is None:
        return None
    raw = block.get("destinations")
    if raw is None:
        return OtelSpec()
    problem = destinations_problem(raw)
    if problem:
        collector.add(block, "destinations", "otel.destinations", problem)
        return OtelSpec()

    destinations = []
    names = set()
    for index, entry in enumerate(raw):
        prefix = f"otel.destinations[{index}]"
        if not isinstance(entry, dict):
            collector.add(
                raw, index, prefix, f"expected a mapping, got {_describe(entry)}"
            )
            continue
        _check_keys(collector, entry, prefix, DESTINATION_KEYS)
        expanded = expand_env_value(entry)
        problems = list(destination_problems(expanded))
        for key, message in problems:
            raw_value = entry.get(key)
            if isinstance(raw_value, str) and ENV_REF.search(raw_value):
                message += _ENV_REF_HINT
            collector.add(entry, key, _field(prefix, key), message)
        if problems:
            continue
        destination = normalize_destination(expanded)
        if destination["name"] in names:
            collector.add(
                entry,
                "name",
                _field(prefix, "name"),
                duplicate_name_message(destination["name"]),
            )
            continue
        names.add(destination["name"])
        destinations.append(
            OtelDestination(
                name=destination["name"],
                protocol=destination["protocol"],
                endpoint=destination["endpoint"],
                headers=destination["headers"] or {},
                insecure=bool(destination["insecure"]),
                timeout=destination["timeout"],
            )
        )
    return OtelSpec(destinations=tuple(destinations))


def _endpoint(collector, node, agent_specs):
    """Parse the required `endpoint` section: the agent method served over HTTP."""
    if "endpoint" not in node or node["endpoint"] is None:
        collector.add(
            node,
            "endpoint",
            "endpoint",
            "is required but missing; add it with the `agent` and `method` to serve "
            "over HTTP",
        )
        return None
    block = _mapping(collector, node, "endpoint", "", _ENDPOINT_KEYS)
    if block is None:
        return None
    agent = _string(collector, block, "agent", "endpoint", required=True)
    method = _string(collector, block, "method", "endpoint", required=True)
    functions = {
        agent_spec.name: {function.name for function in agent_spec.functions}
        for agent_spec in agent_specs
        if agent_spec.type == "agent"
    }
    if agent is not None and agent not in functions:
        collector.add(
            block,
            "agent",
            "endpoint.agent",
            f"{agent!r} is not an `agents:` entry of type 'agent'",
        )
    elif agent in functions and method is not None and method not in functions[agent]:
        collector.add(
            block,
            "method",
            "endpoint.method",
            f"{method!r} is not a `functions:` entry of {agent!r}",
        )
    return EndpointSpec(
        agent=agent,
        method=method,
        api_port=_port(collector, block, "api_port", "endpoint", None),
    )


def _check_declared(collector, node, prefix, keys, missing="is required but missing"):
    """Add a violation for each key in `keys` that is required but missing (reported with
    the `missing` message) or has a value of the wrong type."""
    for key, (kind, required) in keys.items():
        if required and node.get(key) is None:
            collector.add(node, key, _field(prefix, key), missing)
        elif kind == "port":
            _port(collector, node, key, prefix, None)
        elif kind is int:
            _integer(collector, node, key, prefix, None, 1)
        elif kind is list:
            _string_list(collector, node, key, prefix, required)
        elif kind is dict:
            _counts(collector, node, key, prefix)
        else:
            _string(collector, node, key, prefix, required=required)


def _check_provider_sections(collector, node, provider):
    """Check each provider's top-level section of `global_controller.yaml`, such as
    `ec2:`. Unknown and retired keys are always reported. The section is required, and
    its values checked, only for the deployment's `provider`."""
    for name, schema in providers.SCHEMAS.items():
        if not schema.SECTION:
            continue
        block = _mapping(
            collector,
            node,
            schema.SECTION,
            "",
            schema.SECTION_KEYS.keys() | schema.RETIRED_KEYS.keys(),
        )
        for key, message in schema.RETIRED_KEYS.items():
            if key in (block or {}):
                collector.add(block, key, _field(schema.SECTION, key), message)
        if provider != name:
            # Skip the values of a provider not in use; their ${VAR}s may be unset.
            continue
        if block is None:
            required = [
                key for key, (_, needed) in schema.SECTION_KEYS.items() if needed
            ]
            # No section to point at, so the violation names the file only.
            collector.violations.append(
                SchemaViolation(
                    collector.path,
                    0,
                    schema.SECTION,
                    f"is required because provider is {name!r}; it must set "
                    f"{', '.join(required)}",
                )
            )
            continue
        _check_declared(collector, block, schema.SECTION, schema.SECTION_KEYS)


def load_manifest(path):
    """Parse and check `global_controller.yaml`, reporting every problem at once.

    Raises:
        SchemaError: the manifest is unusable; `.violations` holds them all.
    """
    load_root_dotenv(path)
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

    if document is None:
        raise SchemaError([SchemaViolation(path, 0, "", "is empty")])
    if not isinstance(document, dict):
        raise SchemaError(
            [
                SchemaViolation(
                    path, 0, "", f"expected a mapping, got {_describe(document)}"
                )
            ]
        )

    for key, message in _RETIRED_KEYS.items():
        if key in document:
            collector.add(document, key, key, message)
    _check_keys(collector, document, "", _MANIFEST_KEYS | _RETIRED_KEYS.keys())
    agent_specs = _agents(collector, document)
    provider = _provider(collector, document, "")
    manifest = Manifest(
        agents=agent_specs,
        provider=provider,
        poll_interval=_number(collector, document, "poll_interval", "", 5, 0),
        cleanup_interval=_number(collector, document, "cleanup_interval", "", 10, 0),
        project_id=_string(collector, document, "project_id", ""),
        redis=_redis(collector, document),
        logs=_boolean(collector, document, "logs", "", True),
        otel=_otel(collector, document),
        endpoint=_endpoint(collector, document, agent_specs),
        dashboard_port=_port(collector, document, "dashboard_port", "", 8081),
        kubernetes=parse_kubernetes(collector, document),
        path=path,
    )
    _check_provider_sections(collector, document, provider)
    if _unset_reference(_string(collector, document, "ssh_private_key_path", "")):
        collector.add(
            document,
            "ssh_private_key_path",
            "ssh_private_key_path",
            _unset_message(document["ssh_private_key_path"]),
        )
    if collector.violations:
        raise SchemaError(collector.violations)
    return manifest


def _redis(collector, node):
    block = _mapping(collector, node, "redis", "", _REDIS_KEYS)
    if block is None:
        return RedisSpec()
    return RedisSpec(
        host=_string(collector, block, "host", "redis", "localhost") or "localhost",
        port=_port(collector, block, "port", "redis", 6379),
        db=_integer(collector, block, "db", "redis", 0, 0),
    )
