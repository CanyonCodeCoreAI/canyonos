# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""The manifest schema: every key `workflow_group.yaml` and a workflow's
`config/workflow_config.yaml` may carry.

Anything not declared here is rejected, so a typo fails the deploy with a line
number instead of being silently ignored, and a wrong type fails here rather
than deep inside the provisioner once containers are already up.
"""

import ntpath
import multiprocessing
import os
import posixpath
from dataclasses import dataclass, field, replace
from typing import ClassVar

import yaml
from packaging.requirements import InvalidRequirement, Requirement

from canyonos_core.controller.utils.container_names import docker_name
from canyonos_core.controller.utils.config_env import (
    ENV_REF,
    dotenv_applied,
    expand_env_value,
    read_dotenv,
    resolve_env_file,
)
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
from canyonos_core.schema.kubernetes_block import (
    MISSING_SECTION_HINT,
    KubernetesSpec,
    image_name_clashes,
    parse_kubernetes,
)
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

# The workflow group's settings, in the folder `canyonos deploy` runs from, and each
# workflow folder's own config, relative to the folder.
DEPLOYMENT_CONFIG = "workflow_group.yaml"
CONFIG_PATH = os.path.join("config", "workflow_config.yaml")

# What a folder runs and serves.
_WORKFLOW_KEYS = frozenset({"agents", "endpoint"})
_WORKFLOW_ENDPOINT_KEYS = frozenset({"routes"})
# Where and how every folder of the workflow group runs.
_DEPLOYMENT_KEYS = frozenset(
    {
        "workflow_group_id",
        # Each workflow's workflow_id and folder, by its name; the CLI writes it.
        "workflows",
        "target",
        "deploy_mode",
        "provider",
        "poll_interval",
        "cleanup_interval",
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
# Who runs the workflow group: Docker on the deploying machine (the default) or the
# Kubernetes cluster. Keep in sync with the CLI's canyonos/target.py: the CLI and the
# core image ship separately.
TARGETS = ("docker", "kubernetes")
# How each workflow's code agents run: replicas of their own each, or all in one replica.
DEPLOY_MODES = ("distributed", "toy")
_DEPLOYMENT_ENDPOINT_KEYS = frozenset({"api_port"})
_MOVED_TO_DEPLOYMENT = "is a workflow group setting, shared by every workflow: set it in workflow_group.yaml"
_ROUTE_KEYS = frozenset({"agent", "method"})
_REDIS_KEYS = frozenset({"host", "port", "db"})
# Keys that used to mean something and now do nothing, each with the message
# that tells a user carrying one what to do instead.
_RETIRED_KEYS = {
    "database": "is no longer used; telemetry is configured under otel: -- remove it",
    "project_id": "is no longer used; the workflow group's id is workflow_group_id "
    "in workflow_group.yaml -- remove it",
    "deployment_id": "was renamed to workflow_group_id -- rename it",
    **{
        old: f"was renamed to {new}: -- rename it"
        for old, new in providers.RENAMED_SECTIONS.items()
    },
    "env_file": "is no longer used; the `.env` in the workflow folder reaches the "
    "agent replicas by itself -- remove it",
}
_OTEL_KEYS = frozenset({"destinations"})
_RESOURCE_KEYS = frozenset({"cpu", "memory", "gpu"})


# ------------------------------------------------------------------ #
#  Parsed shapes                                                       #
# ------------------------------------------------------------------ #


@dataclass(frozen=True)
class Resources:
    """The compute resources requested for an agent in `workflow_config.yaml`."""

    cpu: float = 1
    memory: float = 512
    gpu: int | None = None


@dataclass(frozen=True)
class RedisSpec:
    """The `redis` section of `workflow_config.yaml`: where the workflow group's Redis runs."""

    host: str = "localhost"
    port: int = 6379
    db: int = 0


@dataclass(frozen=True)
class OtelDestination:
    """One `otel` destination in `workflow_config.yaml`: where to send telemetry."""

    name: str
    protocol: str
    endpoint: str
    headers: dict = field(default_factory=dict)
    insecure: bool = False
    timeout: float | None = None


@dataclass(frozen=True)
class OtelSpec:
    """The `otel` section of `workflow_config.yaml`."""

    destinations: tuple = ()


@dataclass(frozen=True)
class RouteSpec:
    """The agent method a workflow serves, at `POST /<workflow_id>` and at
    `POST /<workflow>/<agent>/<method>`. The workflow and its workflow_id are set when
    the workflow joins a workflow group."""

    agent: str
    method: str
    workflow: str = ""
    workflow_id: str | None = None


@dataclass(frozen=True)
class EndpointSpec:
    """The managed HTTP endpoint configuration: the agent methods it serves."""

    routes: tuple
    api_port: int | None = None


@dataclass(frozen=True)
class _Agent:
    """Fields shared by every entry in `agents`."""

    name: str
    replicas: int = 1
    resources: Resources = field(default_factory=Resources)
    stateful: bool = False
    env: dict = field(default_factory=dict)
    # The workflow folder the agent comes from; set when the workflow joins a workflow group.
    workflow: str = ""

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
class Workflow:
    """A workflow's `config/workflow_config.yaml`, checked and parsed by `load_workflow`."""

    agents: tuple
    routes: tuple = ()


@dataclass(frozen=True)
class Manifest:
    """A workflow group, as `load_deployment` composes it: its `workflow_group.yaml` and the
    agents and routes of every workflow in it, each agent named `<workflow>.<agent>`."""

    agents: tuple
    target: str = TARGETS[0]
    deploy_mode: str = DEPLOY_MODES[0]
    provider: str = providers.DEFAULT
    poll_interval: float = 5
    cleanup_interval: float = 10
    deployment_id: str | None = None
    redis: RedisSpec = field(default_factory=RedisSpec)
    # Streams failure and log detail into each future; read as `config.get("logs", True)`, hence the default.
    logs: bool = True
    otel: OtelSpec | None = None
    endpoint: EndpointSpec | None = None
    dashboard_port: int = 8081
    # Read only by a deploy to Kubernetes.
    kubernetes: KubernetesSpec | None = None
    path: str = ""


# ------------------------------------------------------------------ #
#  Reading and checking                                                #
# ------------------------------------------------------------------ #


def _is_rooted(path):
    """True for a path anchored anywhere but the workflow, on either OS.

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


def _workflow_relative_py(collector, node, key, prefix, required):
    """A source path inside the workflow: relative, no `..`, ending in `.py`."""
    value = _string(collector, node, key, prefix, required=required)
    if value is None:
        return ""
    field_name = _field(prefix, key)
    if _is_rooted(value):
        collector.add(
            node, key, field_name, f"must be relative to the workflow, got {value!r}"
        )
        return ""
    if ".." in value.replace("\\", "/").split("/"):
        collector.add(
            node,
            key,
            field_name,
            f"must not escape the workflow with '..', got {value!r}",
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


def _one_of(collector, node, key, choices):
    """The setting `key` in any casing, lowercased; the first of `choices` when it is
    unset or not one of them."""
    value = _string(collector, node, key, "", choices[0])
    if value.casefold() not in choices:
        collector.add(
            node, key, key, f"expected one of {list(choices)}, got {_describe(value)}"
        )
        return choices[0]
    return value.casefold()


def _target(collector, node):
    """The target in any casing, lowercased; Kubernetes needs the `kubernetes:` section."""
    target = _one_of(collector, node, "target", TARGETS)
    if target == "kubernetes" and node.get("kubernetes") is None:
        collector.add(
            node,
            "target",
            "target",
            "is kubernetes, but the kubernetes: section is missing or empty -- "
            + MISSING_SECTION_HINT,
        )
    return target


def _provider(collector, node, prefix):
    """The provider in any casing, normalized to the spelling records store."""
    if "provider" not in node:
        return providers.DEFAULT
    value = _resolve(node["provider"])
    renamed = next(
        (
            new
            for old, new in providers.RENAMED.items()
            if isinstance(value, str) and old.casefold() == value.casefold()
        ),
        None,
    )
    if renamed is not None:
        collector.add(
            node,
            "provider",
            _field(prefix, "provider"),
            f"was renamed to {renamed} -- use provider: {renamed}",
        )
        return providers.DEFAULT
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
            "entrypoint": _workflow_relative_py(
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
    """Parse the `agents` list in `config/workflow_config.yaml`; two names that differ
    only in case are a violation, since both would get the same image and container
    name."""
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

    # Two agents whose names Docker writes the same way collide on one image, container
    # and data volume: names are lowercased, and a `.` is written `--`.
    seen = {}
    for index, entry, agent_spec in parsed:
        key = docker_name(agent_spec.name)
        if key in seen:
            collector.add(
                entry,
                "name",
                f"agents[{index}].name",
                f"duplicate agent name {agent_spec.name!r}: agents[{seen[key]}] "
                f"already claims it (Docker names both {key!r})",
            )
        else:
            seen[key] = index
    return tuple(agent_spec for _, _, agent_spec in parsed)


def _otel(collector, node):
    """Parse the `otel` section of `workflow_config.yaml`, recording violations for
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


def _routes(collector, node, agent_specs):
    """Parse the workflow's required `endpoint.routes`: the agent methods it serves."""
    if "endpoint" not in node or node["endpoint"] is None:
        collector.add(
            node,
            "endpoint",
            "endpoint",
            "is required but missing; add it with the `routes` to serve over HTTP",
        )
        return ()
    block = _mapping(
        collector, node, "endpoint", "", _WORKFLOW_ENDPOINT_KEYS | {"api_port"}
    )
    if block is None:
        return ()
    if "api_port" in block:
        collector.add(block, "api_port", "endpoint.api_port", _MOVED_TO_DEPLOYMENT)
    raw = block.get("routes")
    if not isinstance(raw, list) or len(raw) != 1:
        collector.add(
            block,
            "routes",
            "endpoint.routes",
            "expected one `agent` and `method` entry, the workflow this folder "
            f"serves, got {_describe(raw)}",
        )
        return ()
    functions = {
        agent_spec.name: {function.name for function in agent_spec.functions}
        for agent_spec in agent_specs
        if agent_spec.type == "agent"
    }
    routes = []
    for index, entry in enumerate(raw):
        prefix = f"endpoint.routes[{index}]"
        if not isinstance(entry, dict):
            collector.add(
                raw, index, prefix, f"expected a mapping, got {_describe(entry)}"
            )
            continue
        _check_keys(collector, entry, prefix, _ROUTE_KEYS)
        agent = _string(collector, entry, "agent", prefix, required=True)
        method = _string(collector, entry, "method", prefix, required=True)
        if agent is not None and agent not in functions:
            collector.add(
                entry,
                "agent",
                f"{prefix}.agent",
                f"{agent!r} is not an `agents:` entry of type 'agent'",
            )
        elif (
            agent in functions and method is not None and method not in functions[agent]
        ):
            collector.add(
                entry,
                "method",
                f"{prefix}.method",
                f"{method!r} is not a `functions:` entry of {agent!r}",
            )
        route = RouteSpec(agent=agent, method=method)
        if route in routes:
            collector.add(entry, "agent", prefix, f"{agent}.{method} is listed twice")
        routes.append(route)
    return tuple(routes)


def _check_declared(
    collector, node, prefix, keys, missing="is required but missing", agent_names=()
):
    """Add a violation for each key in `keys` that is required but missing (reported with
    the `missing` message) or has a value of the wrong type. An `"agents"` key maps each
    of `agent_names` to a string, and takes no other names."""
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
        elif kind == "agents":
            _by_agent(collector, node, key, prefix, agent_names)
        else:
            _string(collector, node, key, prefix, required=required)


def _by_agent(collector, node, key, prefix, agent_names):
    """Check a mapping that gives every agent a string, such as ec2-assign's machine type
    for each: each agent must be listed, and only agents."""
    field = _field(prefix, key)
    value = _string_mapping(collector, node, key, prefix)
    if not isinstance(node.get(key), dict):
        return
    for name in value:
        if name not in agent_names:
            collector.add(
                node[key],
                name,
                _field(field, name),
                f"is not an agent; expected one of {list(agent_names)}",
            )
    missing = [name for name in agent_names if name not in value]
    if missing:
        collector.add(
            node, key, field, f"must give every agent a value; missing {missing}"
        )


def _agents_as_named(document):
    """Let a per-agent provider setting, such as ec2-assign's `machine_type`, name an
    agent `<folder>.<agent>`, as its user knows it: rename it `<workflow>.<agent>`, its
    name in the workflow group, when just one workflow has that folder (see `workflows`)."""
    workflows = {}
    for workflow in document.get("workflows") or {}:
        workflows.setdefault(workflow.rsplit("-", 1)[0], []).append(workflow)
    for schema in providers.SCHEMAS.values():
        section = document.get(schema.SECTION) if schema.MACHINE_PER_REPLICA else None
        by_agent = (
            section.get(schema.MACHINE_PER_REPLICA)
            if isinstance(section, dict)
            else None
        )
        if not isinstance(by_agent, dict):
            continue
        for name in list(by_agent):
            folder, _, agent = str(name).partition(".")
            if len(workflows.get(folder, ())) == 1:
                by_agent[f"{workflows[folder][0]}.{agent}"] = by_agent.pop(name)


def _check_provider_sections(collector, node, provider, agent_names):
    """Check each provider's top-level section of `workflow_group.yaml`, such as
    `ec2-pool:`. Unknown and retired keys are always reported. The section's values are
    checked only for the workflow group's `provider`, and the section itself is required
    then only if it has required keys."""
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
        required = [key for key, (_, needed) in schema.SECTION_KEYS.items() if needed]
        if block is None:
            if not required:
                continue
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
        _check_declared(
            collector,
            block,
            schema.SECTION,
            schema.SECTION_KEYS,
            agent_names=agent_names,
        )


def _read_document(path):
    """`(collector, document)` for one config file, with its retired keys reported.

    Raises:
        SchemaError: the file can't be read, isn't YAML, or isn't a mapping.
    """
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
    collector = _Collector(path)
    for key, message in _RETIRED_KEYS.items():
        if key in document:
            collector.add(document, key, key, message)
    return collector, document


def load_workflow(path):
    """Parse and check a workflow's `config/workflow_config.yaml`, reading its `${VAR}`s
    from the workflow's own `.env` and reporting every problem at once.

    Raises:
        SchemaError: the file is unusable; `.violations` holds them all.
    """
    # A port in `.canyon` reads the `.env` beside it, the one deploy ships.
    with dotenv_applied(resolve_env_file(path) or ""):
        collector, document = _read_document(path)
        moved = document.keys() & (_DEPLOYMENT_KEYS - _WORKFLOW_KEYS)
        for key in moved:
            collector.add(document, key, key, _MOVED_TO_DEPLOYMENT)
        _check_keys(
            collector, document, "", _WORKFLOW_KEYS | moved | _RETIRED_KEYS.keys()
        )
        agent_specs = _agents(collector, document)
        workflow = Workflow(
            agents=agent_specs,
            routes=_routes(collector, document, agent_specs),
        )
    if collector.violations:
        raise SchemaError(collector.violations)
    return workflow


def workflow_names(workspace):
    """The workflows of the workflow group in `workspace`: its folders that hold a
    `config/workflow_config.yaml`, by name."""
    return sorted(
        name
        for name in os.listdir(workspace)
        if os.path.isfile(os.path.join(workspace, name, CONFIG_PATH))
    )


def qualified_name(workflow, agent_name):
    """An agent's name in a workflow group: `<workflow>.<agent>`, unique across workflows.
    Workflow names never hold a `.`, so the workflow is the part before the first one."""
    return f"{workflow}.{agent_name}"


def load_deployment(workspace):
    """Parse and check the workflow group in `workspace`: its `workflow_group.yaml` and every
    workflow's `config/workflow_config.yaml`, composed into one Manifest. Each agent is
    named `<workflow>.<agent>` and records its workflow, and each route its workflow.

    Raises:
        SchemaError: the workflow group is unusable; `.violations` holds the problems of
            every file.
    """
    path = os.path.join(workspace, DEPLOYMENT_CONFIG)
    violations = []
    agent_specs = []
    routes = []
    names = workflow_names(workspace)
    if not names:
        violations.append(
            SchemaViolation(workspace, 0, "", f"holds no folder with {CONFIG_PATH}")
        )
    for name in names:
        try:
            workflow = load_workflow(os.path.join(workspace, name, CONFIG_PATH))
        except SchemaError as error:
            violations.extend(error.violations)
            continue
        agent_specs += [
            replace(
                agent_spec,
                name=qualified_name(name, agent_spec.name),
                workflow=name,
            )
            for agent_spec in workflow.agents
        ]
        routes += [replace(route, workflow=name) for route in workflow.routes]

    with dotenv_applied(os.path.join(workspace, ".env")):
        try:
            collector, document = _read_document(path)
        except SchemaError as error:
            raise SchemaError(violations + list(error.violations)) from None
        _check_keys(collector, document, "", _DEPLOYMENT_KEYS | _RETIRED_KEYS.keys())
        _agents_as_named(document)
        provider = _provider(collector, document, "")
        endpoint = _mapping(
            collector, document, "endpoint", "", _DEPLOYMENT_ENDPOINT_KEYS
        )
        workflows = document.get("workflows") or {}
        routes = [
            replace(
                route,
                workflow_id=(workflows.get(route.workflow) or {}).get("workflow_id"),
            )
            for route in routes
        ]
        manifest = Manifest(
            agents=tuple(agent_specs),
            target=_target(collector, document),
            deploy_mode=_one_of(collector, document, "deploy_mode", DEPLOY_MODES),
            provider=provider,
            poll_interval=_number(collector, document, "poll_interval", "", 5, 0),
            cleanup_interval=_number(
                collector, document, "cleanup_interval", "", 10, 0
            ),
            deployment_id=_string(collector, document, "workflow_group_id", ""),
            redis=_redis(collector, document),
            logs=_boolean(collector, document, "logs", "", True),
            otel=_otel(collector, document),
            endpoint=EndpointSpec(
                routes=tuple(routes),
                api_port=_port(collector, endpoint, "api_port", "endpoint", None)
                if endpoint
                else None,
            ),
            dashboard_port=_port(collector, document, "dashboard_port", "", 8081),
            kubernetes=parse_kubernetes(collector, document),
            path=path,
        )
        _check_provider_sections(
            collector,
            document,
            provider,
            [agent_spec.name for agent_spec in agent_specs],
        )
        # On Docker a toy bundle mounts its files from the Global Controller's machine.
        if (
            manifest.deploy_mode == "toy"
            and manifest.target == "docker"
            and provider != providers.DEFAULT
        ):
            collector.add(
                document,
                "deploy_mode",
                "deploy_mode",
                "toy runs every agent on this machine, so it needs `provider: local`",
            )
        if _unset_reference(_string(collector, document, "ssh_private_key_path", "")):
            collector.add(
                document,
                "ssh_private_key_path",
                "ssh_private_key_path",
                _unset_message(document["ssh_private_key_path"]),
            )
    if manifest.kubernetes is not None:
        violations += image_name_clashes(
            agent_specs, lambda workflow: os.path.join(workspace, workflow, CONFIG_PATH)
        )
    violations += collector.violations
    if violations:
        raise SchemaError(violations)
    return manifest


def _expanded(path, env_path):
    """The YAML at `path`, its `${VAR}`s expanded from the `.env` at `env_path`, the
    environment's own values winning."""
    with open(path, encoding="utf-8") as f:
        return expand_env_value(
            yaml.safe_load(f), {**read_dotenv(env_path), **os.environ}
        )


def load_deployment_config(workspace):
    """The workflow group in `workspace` as the raw config the Global Controller acts on,
    composed the way `load_deployment` composes the Manifest: `workflow_group.yaml`, plus
    every workflow's agents, named `<workflow>.<agent>` and given their `workflow`, and
    its routes, given their `workflow`. Read once `load_deployment` has accepted it."""
    config = _expanded(
        os.path.join(workspace, DEPLOYMENT_CONFIG), os.path.join(workspace, ".env")
    )
    config["deploy_mode"] = str(config.get("deploy_mode", DEPLOY_MODES[0])).casefold()
    _agents_as_named(config)
    agent_specs = []
    routes = []
    for name in workflow_names(workspace):
        workflow = _expanded(
            os.path.join(workspace, name, CONFIG_PATH),
            os.path.join(workspace, name, ".env"),
        )
        workflow_specs = [
            {
                **agent_spec,
                "name": qualified_name(name, agent_spec["name"]),
                "workflow": name,
            }
            for agent_spec in workflow["agents"]
        ]
        agent_specs += (
            _toy_bundle(name, workflow_specs)
            if config["deploy_mode"] == "toy"
            else workflow_specs
        )
        workflow_id = ((config.get("workflows") or {}).get(name) or {}).get(
            "workflow_id"
        )
        routes += [
            {**route, "workflow": name, "workflow_id": workflow_id}
            for route in workflow["endpoint"]["routes"]
        ]
    config["agents"] = agent_specs
    config["endpoint"] = {**(config.get("endpoint") or {}), "routes": routes}
    return config


def _toy_bundle(workflow, agent_specs):
    """A workflow's agent specs for toy mode: its databases as they are, and one spec
    whose single replica runs every code agent, listed under its `agents`, with their
    resources added up, CPU at most the machine's, and their requirements combined."""
    hosted = [spec for spec in agent_specs if spec.get("type", "agent") == "agent"]
    defaults = Resources()
    bundle = {
        "name": qualified_name(workflow, "toy"),
        "workflow": workflow,
        "type": "agent",
        # An agent that sets no resources gets the defaults, as its own replica would.
        "resources": {
            key: sum(
                (spec.get("resources") or {}).get(key) or getattr(defaults, key) or 0
                for spec in hosted
            )
            for key in _RESOURCE_KEYS
        },
        "requirements": list(
            dict.fromkeys(
                requirement
                for spec in hosted
                for requirement in spec.get("requirements") or []
            )
        ),
        "agents": hosted,
    }
    # Docker refuses a CPU limit above the machine's, which a sum over many agents can pass.
    bundle["resources"]["cpu"] = min(
        bundle["resources"]["cpu"], multiprocessing.cpu_count()
    )
    return [*(spec for spec in agent_specs if spec.get("type") == "database"), bundle]


def _redis(collector, node):
    block = _mapping(collector, node, "redis", "", _REDIS_KEYS)
    if block is None:
        return RedisSpec()
    return RedisSpec(
        host=_string(collector, block, "host", "redis", "localhost") or "localhost",
        port=_port(collector, block, "port", "redis", 6379),
        db=_integer(collector, block, "db", "redis", 0, 0),
    )
