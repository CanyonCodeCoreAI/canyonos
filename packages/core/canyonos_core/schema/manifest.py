"""The manifest schema: every key `global_controller.yaml` may carry.

Anything not declared here is rejected, so a typo fails the deploy with a line
number instead of being silently ignored, and a wrong type fails here rather
than deep inside the instance manager once containers are already up.
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
from canyonos_core.schema._checks import (
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
)
from canyonos_core.schema.errors import SchemaError, SchemaViolation
from canyonos_core.schema.otel_destinations import (
    DESTINATION_KEYS,
    destination_problems,
    destinations_problem,
    duplicate_name_message,
    normalize_destination,
)
from canyonos_core.schema.yaml_lines import load_yaml_lines, parse_failure

SERVICE_TYPES = ("agent", "workflow", "database")
PROVIDERS = ("local", "EC2")

# Keys every service entry may carry, whatever its type.
_COMMON_SERVICE_KEYS = frozenset(
    {
        "name",
        "type",
        "provider",
        "replicas",
        "redis_port",
        "resources",
        "stateful",
        "instance_type",
        "env",
        "host",
        "port",
        "host_port",
        "user",
    }
)
_AGENT_KEYS = _COMMON_SERVICE_KEYS | {"entrypoint", "requirements"}
_WORKFLOW_KEYS = _COMMON_SERVICE_KEYS | {
    "workflow_file",
    "requirements",
    "api_port",
    "dashboard_port",
}
_DATABASE_KEYS = _COMMON_SERVICE_KEYS | {"image", "db_port", "volume_path"}
_ALL_SERVICE_KEYS = _AGENT_KEYS | _WORKFLOW_KEYS | _DATABASE_KEYS
_SERVICE_KEYS_BY_TYPE = {
    "agent": _AGENT_KEYS,
    "workflow": _WORKFLOW_KEYS,
    "database": _DATABASE_KEYS,
}

_MANIFEST_KEYS = frozenset(
    {
        "agents",
        "poll_interval",
        "cleanup_interval",
        "project_id",
        "redis",
        "env_file",
        "logs",
        "otel",
        "ec2",
    }
)
_REDIS_KEYS = frozenset({"host", "port", "db"})
# Keys that used to mean something and now do nothing, each with the message
# that tells a user carrying one what to do instead.
_RETIRED_KEYS = {
    "database": "is no longer used; telemetry is configured under otel: -- remove it",
}
_OTEL_KEYS = frozenset({"destinations"})
_EC2_KEYS = frozenset(
    {
        "region",
        "ami_id",
        "subnet_id",
        "security_group_ids",
        "ssh_user",
        "ssh_private_key_path",
        "public_ip_timeout",
        "controller_health_timeout",
    }
)
_EC2_REQUIRED_KEYS = ("region", "ami_id", "subnet_id", "security_group_ids", "ssh_user")
_RESOURCE_KEYS = frozenset({"cpu", "memory", "gpu"})


# ------------------------------------------------------------------ #
#  Parsed shapes                                                       #
# ------------------------------------------------------------------ #


@dataclass(frozen=True)
class Resources:
    cpu: float = 1
    memory: float = 512
    gpu: float | None = None


@dataclass(frozen=True)
class RedisSpec:
    host: str = "localhost"
    port: int = 6379
    db: int = 0


@dataclass(frozen=True)
class OtelDestination:
    name: str
    protocol: str
    endpoint: str
    headers: dict = field(default_factory=dict)
    insecure: bool = False
    timeout: float | None = None


@dataclass(frozen=True)
class OtelSpec:
    destinations: tuple = ()


@dataclass(frozen=True)
class Ec2Spec:
    region: str
    ami_id: str
    subnet_id: str
    security_group_ids: tuple
    ssh_user: str
    ssh_private_key_path: str = "~/.ssh/ventis_ec2"
    public_ip_timeout: int = 120
    controller_health_timeout: int = 180


@dataclass(frozen=True)
class _Service:
    """Fields shared by every service entry in `agents`."""

    name: str
    provider: str = "local"
    replicas: int = 1
    redis_port: int = 6379
    resources: Resources = field(default_factory=Resources)
    stateful: bool = False
    instance_type: str | None = None
    env: dict = field(default_factory=dict)
    host: str | None = None
    port: int | None = None
    host_port: int | None = None
    user: str | None = None

    type: ClassVar[str] = "agent"


@dataclass(frozen=True)
class AgentService(_Service):
    entrypoint: str = ""
    requirements: tuple = ()
    requirement_lines: tuple = field(default=(), compare=False, repr=False)

    type: ClassVar[str] = "agent"


@dataclass(frozen=True)
class WorkflowService(_Service):
    workflow_file: str = ""
    requirements: tuple = ()
    requirement_lines: tuple = field(default=(), compare=False, repr=False)
    api_port: int = 8080
    dashboard_port: int = 8081

    type: ClassVar[str] = "workflow"


@dataclass(frozen=True)
class DatabaseService(_Service):
    image: str = ""
    db_port: int = 5432
    volume_path: str | None = None

    type: ClassVar[str] = "database"


@dataclass(frozen=True)
class Manifest:
    agents: tuple
    poll_interval: float = 5
    cleanup_interval: float = 10
    project_id: str | None = None
    redis: RedisSpec = field(default_factory=RedisSpec)
    env_file: str | None = None
    # Streams failure and log detail into each future; read as
    # `config.get("logs", True)` by both runtimes, hence the default.
    logs: bool = True
    otel: OtelSpec | None = None
    ec2: Ec2Spec | None = None
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
        gpu = _number(collector, block, "gpu", prefix, None, floor=0)
    return Resources(
        cpu=_number(collector, block, "cpu", prefix, 1, 0),
        memory=_number(collector, block, "memory", prefix, 512, 0),
        gpu=gpu,
    )


def _service_type(collector, node, prefix):
    if "type" not in node:
        return "agent"
    value = _resolve(node["type"])
    if value not in SERVICE_TYPES:
        collector.add(
            node,
            "type",
            _field(prefix, "type"),
            f"expected one of {list(SERVICE_TYPES)}, got {_describe(value)}",
        )
        return None
    return value


def _provider(collector, node, prefix):
    """The provider in any casing, normalized to the spelling the runtimes compare.

    cli._load_config accepts `LOCAL` or `ec2` and rewrites them the same way, so
    the gate in front of it has to as well.
    """
    if "provider" not in node:
        return "local"
    value = _resolve(node["provider"])
    canonical = {p.casefold(): p for p in PROVIDERS}
    if not isinstance(value, str) or value.casefold() not in canonical:
        collector.add(
            node,
            "provider",
            _field(prefix, "provider"),
            f"expected one of {list(PROVIDERS)}, got {_describe(value)}",
        )
        return "local"
    return canonical[value.casefold()]


def _service(collector, entries, index):
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

    service_type = _service_type(collector, node, prefix)
    _check_service_keys(collector, node, prefix, service_type)

    name = _string(collector, node, "name", prefix, required=True)
    common = {
        "name": name,
        "provider": _provider(collector, node, prefix),
        "replicas": _integer(collector, node, "replicas", prefix, 1, 1),
        "redis_port": _port(collector, node, "redis_port", prefix, 6379),
        "resources": _resources(collector, node, prefix),
        "stateful": _boolean(collector, node, "stateful", prefix, False),
        "instance_type": _string(collector, node, "instance_type", prefix),
        "env": _string_mapping(collector, node, "env", prefix),
        "host": _string(collector, node, "host", prefix),
        "port": _port(collector, node, "port", prefix, None),
        "host_port": _port(collector, node, "host_port", prefix, None),
        "user": _string(collector, node, "user", prefix),
    }

    if common["provider"] == "EC2" and not common["instance_type"]:
        collector.add(
            node,
            "instance_type",
            _field(prefix, "instance_type"),
            "is required when provider is 'EC2'",
        )

    if service_type == "workflow":
        if common["provider"] == "local" and common["replicas"] > 1:
            collector.add(
                node,
                "replicas",
                _field(prefix, "replicas"),
                "a local workflow runs as a single replica: every replica "
                "would publish the same api_port",
            )
        service_class = WorkflowService
        fields = {
            "workflow_file": _project_relative_py(
                collector, node, "workflow_file", prefix, required=True
            ),
            "requirements": _requirements(collector, node, prefix),
            "requirement_lines": _item_lines(node, "requirements"),
            "api_port": _port(collector, node, "api_port", prefix, 8080),
            "dashboard_port": _port(collector, node, "dashboard_port", prefix, 8081),
        }
    elif service_type == "database":
        if common["replicas"] != 1:
            collector.add(
                node,
                "replicas",
                _field(prefix, "replicas"),
                f"a database runs as a single container, got {_describe(node['replicas'])}",
            )
        service_class = DatabaseService
        fields = {
            "image": _string(collector, node, "image", prefix, "", required=True) or "",
            "db_port": _port(collector, node, "db_port", prefix, 5432),
            "volume_path": _string(collector, node, "volume_path", prefix),
        }
    elif service_type == "agent":
        service_class = AgentService
        fields = {
            "entrypoint": _project_relative_py(
                collector, node, "entrypoint", prefix, required=True
            ),
            "requirements": _requirements(collector, node, prefix),
            "requirement_lines": _item_lines(node, "requirements"),
        }
    else:
        return None

    if name is None:
        return None
    return service_class(**common, **fields)


def _check_service_keys(collector, node, prefix, service_type):
    allowed = _SERVICE_KEYS_BY_TYPE.get(service_type, _ALL_SERVICE_KEYS)
    for key in node:
        if key in allowed:
            continue
        if key in _ALL_SERVICE_KEYS:
            message = f"key {key!r} is not valid for type {service_type!r}"
        else:
            message = _unknown_key_message(key, allowed)
        collector.add(node, key, _field(prefix, key), message)


def _services(collector, node):
    if "agents" not in node or node["agents"] is None:
        collector.add(node, "agents", "agents", "is required but missing")
        return ()
    raw = node["agents"]
    if not isinstance(raw, list):
        collector.add(
            node,
            "agents",
            "agents",
            f"expected a list of services, got {_describe(raw)}",
        )
        return ()

    parsed = []
    for index, entry in enumerate(raw):
        service = _service(collector, raw, index)
        if service is not None:
            parsed.append((index, entry, service))

    # Two services whose names differ only in case collide: the image tag and
    # the container name are both built from `name.lower()`.
    seen = {}
    for index, entry, service in parsed:
        key = service.name.lower()
        if key in seen:
            collector.add(
                entry,
                "name",
                f"agents[{index}].name",
                f"duplicate service name {service.name!r}: agents[{seen[key]}] "
                "already claims it (names are lowercased into one image tag)",
            )
        else:
            seen[key] = index
    return tuple(service for _, _, service in parsed)


def _otel(collector, node):
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


def _ec2(collector, node, services):
    block = _mapping(collector, node, "ec2", "", _EC2_KEYS)
    if not any(service.provider == "EC2" for service in services):
        # Only an EC2 deploy reads the block; a local project may carry one
        # whose variables are unset.
        return None
    if block is None:
        # No `ec2:` to point at, so the violation names the file only.
        collector.violations.append(
            SchemaViolation(
                collector.path,
                0,
                "ec2",
                "is required because a service declares provider 'EC2'; it "
                f"must set {', '.join(_EC2_REQUIRED_KEYS)}",
            )
        )
        return None

    region = _string(collector, block, "region", "ec2", required=True)
    ami_id = _string(collector, block, "ami_id", "ec2", required=True)
    subnet_id = _string(collector, block, "subnet_id", "ec2", required=True)
    ssh_user = _string(collector, block, "ssh_user", "ec2", required=True)
    security_group_ids = _string_list(
        collector, block, "security_group_ids", "ec2", required=True
    )
    ssh_private_key_path = (
        _string(collector, block, "ssh_private_key_path", "ec2", "~/.ssh/ventis_ec2")
        or "~/.ssh/ventis_ec2"
    )
    public_ip_timeout = _integer(collector, block, "public_ip_timeout", "ec2", 120, 1)
    controller_health_timeout = _integer(
        collector, block, "controller_health_timeout", "ec2", 180, 1
    )
    if not (region and ami_id and subnet_id and ssh_user and security_group_ids):
        return None
    return Ec2Spec(
        region=region,
        ami_id=ami_id,
        subnet_id=subnet_id,
        security_group_ids=security_group_ids,
        ssh_user=ssh_user,
        ssh_private_key_path=ssh_private_key_path,
        public_ip_timeout=public_ip_timeout,
        controller_health_timeout=controller_health_timeout,
    )


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
    services = _services(collector, document)
    manifest = Manifest(
        agents=services,
        poll_interval=_number(collector, document, "poll_interval", "", 5, 0),
        cleanup_interval=_number(collector, document, "cleanup_interval", "", 10, 0),
        project_id=_string(collector, document, "project_id", ""),
        redis=_redis(collector, document),
        env_file=_string(collector, document, "env_file", ""),
        logs=_boolean(collector, document, "logs", "", True),
        otel=_otel(collector, document),
        ec2=_ec2(collector, document, services),
        path=path,
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
