"""The manifest schema: every key `global_controller.yaml` may carry.

Anything not declared here is rejected, so a typo fails the deploy with a line
number instead of being silently ignored, and a wrong type fails here rather
than deep inside the instance manager once containers are already up.
"""

import difflib
import posixpath
import re
from dataclasses import dataclass, field
from typing import ClassVar

import yaml

from canyonos_core.controller.utils.config_env import (
    ENV_REF,
    expand_env_value,
    load_root_dotenv,
)
from canyonos_core.schema.errors import SchemaError, SchemaViolation
from canyonos_core.schema.yaml_lines import line_of, load_yaml_lines

SERVICE_TYPES = ("agent", "workflow", "database")
PROVIDERS = ("local", "EC2")
OTEL_PROTOCOLS = ("grpc", "http")

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
        "database",
        "env_file",
        "otel",
        "ec2",
    }
)
_REDIS_KEYS = frozenset({"host", "port", "db"})
_DATABASE_BLOCK_KEYS = frozenset({"url"})
_OTEL_KEYS = frozenset({"destinations"})
_OTEL_DESTINATION_KEYS = frozenset(
    {"name", "protocol", "endpoint", "headers", "insecure", "timeout"}
)
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

# A value written as nothing but one `${VAR}` gets the type it would have had if
# the variable's text had been typed into the YAML directly, so `api_port:
# ${API_PORT}` with API_PORT=9000 is the integer 9000 and not the string "9000".
_WHOLE_ENV_REF = re.compile(f"^{ENV_REF.pattern}$")


# ------------------------------------------------------------------ #
#  Parsed shapes                                                       #
# ------------------------------------------------------------------ #


@dataclass(frozen=True)
class Resources:
    cpu: int = 1
    memory: int = 512
    gpu: int | None = None

    def to_dict(self):
        spec = {"cpu": self.cpu, "memory": self.memory}
        if self.gpu is not None:
            spec["gpu"] = self.gpu
        return spec


@dataclass(frozen=True)
class RedisSpec:
    host: str = "localhost"
    port: int = 6379
    db: int = 0

    def to_dict(self):
        return {"host": self.host, "port": self.port, "db": self.db}


@dataclass(frozen=True)
class DatabaseSpec:
    url: str

    def to_dict(self):
        return {"url": self.url}


@dataclass(frozen=True)
class OtelDestination:
    name: str
    protocol: str
    endpoint: str
    headers: dict = field(default_factory=dict)
    insecure: bool = False
    timeout: float | None = None

    def to_dict(self):
        spec = {
            "name": self.name,
            "protocol": self.protocol,
            "endpoint": self.endpoint,
            "headers": dict(self.headers),
            "insecure": self.insecure,
        }
        if self.timeout is not None:
            spec["timeout"] = self.timeout
        return spec


@dataclass(frozen=True)
class OtelSpec:
    destinations: tuple = ()

    def to_dict(self):
        return {"destinations": [d.to_dict() for d in self.destinations]}


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

    def to_dict(self):
        return {
            "region": self.region,
            "ami_id": self.ami_id,
            "subnet_id": self.subnet_id,
            "security_group_ids": list(self.security_group_ids),
            "ssh_user": self.ssh_user,
            "ssh_private_key_path": self.ssh_private_key_path,
            "public_ip_timeout": self.public_ip_timeout,
            "controller_health_timeout": self.controller_health_timeout,
        }


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

    def _common_dict(self):
        spec = {
            "name": self.name,
            "type": self.type,
            "provider": self.provider,
            "replicas": self.replicas,
            "redis_port": self.redis_port,
            "resources": self.resources.to_dict(),
            "stateful": self.stateful,
            "env": dict(self.env),
            "instance_type": self.instance_type,
            "host": self.host,
            "port": self.port,
            "host_port": self.host_port,
            "user": self.user,
        }
        return {key: value for key, value in spec.items() if value is not None}


@dataclass(frozen=True)
class AgentService(_Service):
    entrypoint: str = ""
    requirements: tuple = ()

    type: ClassVar[str] = "agent"

    def to_dict(self):
        return {
            **self._common_dict(),
            "entrypoint": self.entrypoint,
            "requirements": list(self.requirements),
        }


@dataclass(frozen=True)
class WorkflowService(_Service):
    workflow_file: str = ""
    requirements: tuple = ()
    api_port: int = 8080
    dashboard_port: int = 8081

    type: ClassVar[str] = "workflow"

    def to_dict(self):
        return {
            **self._common_dict(),
            "workflow_file": self.workflow_file,
            "requirements": list(self.requirements),
            "api_port": self.api_port,
            "dashboard_port": self.dashboard_port,
        }


@dataclass(frozen=True)
class DatabaseService(_Service):
    image: str = ""
    db_port: int = 5432
    volume_path: str | None = None

    type: ClassVar[str] = "database"

    def to_dict(self):
        spec = {**self._common_dict(), "image": self.image, "db_port": self.db_port}
        if self.volume_path is not None:
            spec["volume_path"] = self.volume_path
        return spec


@dataclass(frozen=True)
class Manifest:
    agents: tuple
    poll_interval: int = 5
    cleanup_interval: int = 10
    project_id: str | None = None
    redis: RedisSpec = field(default_factory=RedisSpec)
    database: DatabaseSpec | None = None
    env_file: str | None = None
    otel: OtelSpec | None = None
    ec2: Ec2Spec | None = None
    path: str = ""

    def to_dict(self):
        """The manifest as the controller's dict readers expect it, defaults filled in."""
        spec = {
            "agents": [service.to_dict() for service in self.agents],
            "poll_interval": self.poll_interval,
            "cleanup_interval": self.cleanup_interval,
            "redis": self.redis.to_dict(),
        }
        if self.project_id is not None:
            spec["project_id"] = self.project_id
        if self.database is not None:
            spec["database"] = self.database.to_dict()
        if self.env_file is not None:
            spec["env_file"] = self.env_file
        if self.otel is not None:
            spec["otel"] = self.otel.to_dict()
        if self.ec2 is not None:
            spec["ec2"] = self.ec2.to_dict()
        return spec


# ------------------------------------------------------------------ #
#  Reading and checking                                                #
# ------------------------------------------------------------------ #


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
    """Expand `${VAR}` refs in a scalar, re-typing a value that is only a ref."""
    if not isinstance(raw, str):
        return raw
    expanded = expand_env_value(raw)
    if not ENV_REF.search(raw) or ENV_REF.search(expanded):
        # Nothing to expand, or the variable is unset -- the controller leaves
        # the literal `${VAR}` in place, so the schema checks that same text.
        return expanded
    if _WHOLE_ENV_REF.match(raw):
        return yaml.safe_load(expanded)
    return expanded


class _Collector:
    """Accumulates every violation in one file instead of stopping at the first."""

    def __init__(self, path):
        self.path = path
        self.violations = []

    def add(self, node, key, field_name, message):
        self.violations.append(
            SchemaViolation(self.path, line_of(node, key), field_name, message)
        )


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


def _field(prefix, key):
    return f"{prefix}.{key}" if prefix else str(key)


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


def _integer(collector, node, key, prefix, default, minimum=None):
    if key not in node:
        return default
    value = _resolve(node[key])
    bound = f" >= {minimum}" if minimum is not None else ""
    if isinstance(value, bool) or not isinstance(value, int):
        collector.add(
            node,
            key,
            _field(prefix, key),
            f"expected an integer{bound}, got {_describe(value)}",
        )
        return default
    if minimum is not None and value < minimum:
        collector.add(
            node,
            key,
            _field(prefix, key),
            f"expected an integer{bound}, got {_describe(value)}",
        )
        return default
    return value


def _string(collector, node, key, prefix, default=None, required=False):
    if key not in node or node[key] is None:
        if required:
            collector.add(node, key, _field(prefix, key), "is required but missing")
        return default
    value = _resolve(node[key])
    if not isinstance(value, str) or not value.strip():
        collector.add(
            node,
            key,
            _field(prefix, key),
            f"expected a non-empty string, got {_describe(value)}",
        )
        return default
    return value


def _boolean(collector, node, key, prefix, default):
    if key not in node:
        return default
    value = _resolve(node[key])
    if not isinstance(value, bool):
        collector.add(
            node,
            key,
            _field(prefix, key),
            f"expected a boolean, got {_describe(value)}",
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
    items = [_resolve(item) for item in value]
    if not all(isinstance(item, str) and item.strip() for item in items):
        collector.add(
            node,
            key,
            _field(prefix, key),
            f"expected a list of strings, got {_describe(value)}",
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


def _project_relative_py(collector, node, key, prefix, required):
    """A source path inside the project: relative, no `..`, ending in `.py`."""
    value = _string(collector, node, key, prefix, required=required)
    if value is None:
        return ""
    field_name = _field(prefix, key)
    if posixpath.isabs(value) or (len(value) > 1 and value[1] == ":"):
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


def _resources(collector, node, prefix):
    block = _mapping(collector, node, "resources", prefix, _RESOURCE_KEYS)
    if block is None:
        return Resources()
    gpu = None
    if "gpu" in block:
        gpu = _integer(collector, block, "gpu", _field(prefix, "resources"), None, 0)
    return Resources(
        cpu=_integer(collector, block, "cpu", _field(prefix, "resources"), 1, 1),
        memory=_integer(
            collector, block, "memory", _field(prefix, "resources"), 512, 1
        ),
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
    if "provider" not in node:
        return "local"
    value = _resolve(node["provider"])
    if value not in PROVIDERS:
        collector.add(
            node,
            "provider",
            _field(prefix, "provider"),
            f"expected one of {list(PROVIDERS)} (case-sensitive), got {_describe(value)}",
        )
        return "local"
    return value


def _service(collector, node, index):
    """Parse one entry of `agents`, or None when it cannot be identified."""
    prefix = f"agents[{index}]"
    if not isinstance(node, dict):
        collector.violations.append(
            SchemaViolation(
                collector.path, 0, prefix, f"expected a mapping, got {_describe(node)}"
            )
        )
        return None

    service_type = _service_type(collector, node, prefix)
    if service_type is None:
        return None
    _check_service_keys(collector, node, prefix, service_type)

    name = _string(collector, node, "name", prefix, required=True)
    if name is None:
        return None

    common = {
        "name": name,
        "provider": _provider(collector, node, prefix),
        "replicas": _integer(collector, node, "replicas", prefix, 1, 1),
        "redis_port": _integer(collector, node, "redis_port", prefix, 6379, 1),
        "resources": _resources(collector, node, prefix),
        "stateful": _boolean(collector, node, "stateful", prefix, False),
        "instance_type": _string(collector, node, "instance_type", prefix),
        "env": _string_mapping(collector, node, "env", prefix),
        "host": _string(collector, node, "host", prefix),
        "port": _integer(collector, node, "port", prefix, None, 1),
        "host_port": _integer(collector, node, "host_port", prefix, None, 1),
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
        return WorkflowService(
            **common,
            workflow_file=_project_relative_py(
                collector, node, "workflow_file", prefix, required=True
            ),
            requirements=_string_list(collector, node, "requirements", prefix),
            api_port=_integer(collector, node, "api_port", prefix, 8080, 1),
            dashboard_port=_integer(collector, node, "dashboard_port", prefix, 8081, 1),
        )

    if service_type == "database":
        if common["replicas"] != 1:
            collector.add(
                node,
                "replicas",
                _field(prefix, "replicas"),
                f"a database runs as a single container, got {_describe(node['replicas'])}",
            )
        return DatabaseService(
            **common,
            image=_string(collector, node, "image", prefix, "", required=True) or "",
            db_port=_integer(collector, node, "db_port", prefix, 5432, 1),
            volume_path=_string(collector, node, "volume_path", prefix),
        )

    return AgentService(
        **common,
        entrypoint=_project_relative_py(
            collector, node, "entrypoint", prefix, required=True
        ),
        requirements=_string_list(collector, node, "requirements", prefix),
    )


def _check_service_keys(collector, node, prefix, service_type):
    allowed = _SERVICE_KEYS_BY_TYPE[service_type]
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
        service = _service(collector, entry, index)
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
    if not isinstance(raw, list):
        collector.add(
            block,
            "destinations",
            "otel.destinations",
            f"expected a list of destinations, got {_describe(raw)}",
        )
        return OtelSpec()

    destinations = []
    for index, entry in enumerate(raw):
        prefix = f"otel.destinations[{index}]"
        if not isinstance(entry, dict):
            collector.add(
                block,
                "destinations",
                prefix,
                f"expected a mapping, got {_describe(entry)}",
            )
            continue
        _check_keys(collector, entry, prefix, _OTEL_DESTINATION_KEYS)
        name = _string(collector, entry, "name", prefix, required=True)
        endpoint = _string(collector, entry, "endpoint", prefix, required=True)
        protocol = _string(collector, entry, "protocol", prefix, required=True)
        if protocol is not None and protocol not in OTEL_PROTOCOLS:
            collector.add(
                entry,
                "protocol",
                _field(prefix, "protocol"),
                f"expected one of {list(OTEL_PROTOCOLS)}, got {_describe(protocol)}",
            )
            protocol = None
        timeout = None
        if entry.get("timeout") is not None:
            timeout = _integer(collector, entry, "timeout", prefix, None, 1)
        if name and endpoint and protocol:
            destinations.append(
                OtelDestination(
                    name=name,
                    protocol=protocol,
                    endpoint=endpoint,
                    headers=_string_mapping(collector, entry, "headers", prefix),
                    insecure=_boolean(collector, entry, "insecure", prefix, False),
                    timeout=timeout,
                )
            )
    return OtelSpec(destinations=tuple(destinations))


def _ec2(collector, node, services):
    block = _mapping(collector, node, "ec2", "", _EC2_KEYS)
    needs_ec2 = any(service.provider == "EC2" for service in services)
    if block is None:
        if needs_ec2:
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
    if not (region and ami_id and subnet_id and ssh_user and security_group_ids):
        return None
    return Ec2Spec(
        region=region,
        ami_id=ami_id,
        subnet_id=subnet_id,
        security_group_ids=security_group_ids,
        ssh_user=ssh_user,
        ssh_private_key_path=_string(
            collector, block, "ssh_private_key_path", "ec2", "~/.ssh/ventis_ec2"
        )
        or "~/.ssh/ventis_ec2",
        public_ip_timeout=_integer(
            collector, block, "public_ip_timeout", "ec2", 120, 1
        ),
        controller_health_timeout=_integer(
            collector, block, "controller_health_timeout", "ec2", 180, 1
        ),
    )


def _database(collector, node):
    block = _mapping(collector, node, "database", "", _DATABASE_BLOCK_KEYS)
    if block is None:
        # `database:` with nothing under it parses as None -- no database, not an error.
        return None
    url = _string(collector, block, "url", "database", required=True)
    return DatabaseSpec(url=url) if url else None


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
        raise SchemaError(
            [SchemaViolation(path, 0, "", f"is not valid YAML: {exc}")]
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

    _check_keys(collector, document, "", _MANIFEST_KEYS)
    services = _services(collector, document)
    manifest = Manifest(
        agents=services,
        poll_interval=_integer(collector, document, "poll_interval", "", 5, 1),
        cleanup_interval=_integer(collector, document, "cleanup_interval", "", 10, 1),
        project_id=_string(collector, document, "project_id", ""),
        redis=_redis(collector, document),
        database=_database(collector, document),
        env_file=_string(collector, document, "env_file", ""),
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
        port=_integer(collector, block, "port", "redis", 6379, 1),
        db=_integer(collector, block, "db", "redis", 0, 0),
    )
