# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""The `kubernetes:` section of `global_controller.yaml`: where `canyonos deploy
--target kubernetes` puts the project and how it fits the customer's cluster.

Optional, and read only by that deploy: Docker and EC2 deploys ignore it. When it is
there, its values are checked like any other section, and the agents' Kubernetes
names (the same rule as the operator's) must not collide with each other or with the
project's own objects.
"""

import re
from dataclasses import dataclass, field

from canyonos_core.kubernetes.api import resource_name
from canyonos_core.schema._checks import (
    _boolean,
    _integer,
    _mapping,
    _port,
    _string,
    _string_mapping,
)

SECTION = "kubernetes"
KEYS = frozenset(
    {
        "namespace",
        "registry",
        "platform",
        "service_account",
        "image_pull_secret",
        "env_secret",
        "node_selector",
        "redis",
        "endpoint",
        "databases",
    }
)
DATABASE_KEYS = frozenset({"run_as_user", "fs_group", "storage", "storage_class"})
REDIS_KEYS = frozenset(
    {"storage", "storage_class", "host", "port", "tls", "password_secret"}
)
ENDPOINT_KEYS = frozenset({"host", "ingress_class", "tls_secret", "url"})

# The project's own objects in its namespace; no agent may be named like them.
RESERVED_NAMES = frozenset(
    {"endpoint", "canyonos-endpoint", "canyonos-redis", "canyonos-gc"}
)

_DNS_LABEL = re.compile(r"^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$")
_DNS_NAME = re.compile(
    r"^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$"
)
_QUANTITY = re.compile(r"^[0-9]+(\.[0-9]+)?(Ki|Mi|Gi|Ti)?$")
_PLATFORM = re.compile(r"^linux/(amd64|arm64)$")
_URL = re.compile(r"^https?://[^\s/?#]+(/[^\s?#]*)?$")


@dataclass(frozen=True)
class KubernetesRedis:
    """The project's Redis on Kubernetes: one the operator runs (storage), or the
    customer's own (host)."""

    storage: str = "1Gi"
    storage_class: str | None = None
    host: str | None = None
    port: int = 6379
    tls: bool = False
    password_secret: str | None = None


@dataclass(frozen=True)
class KubernetesEndpoint:
    """How callers outside the cluster reach the endpoint: an Ingress at `host`, or a
    `url` the customer exposes it at. Neither: inside the cluster only."""

    host: str | None = None
    ingress_class: str | None = None
    tls_secret: str | None = None
    url: str | None = None


@dataclass(frozen=True)
class KubernetesDatabase:
    """How one database agent runs on Kubernetes: the user IDs its stock image
    expects (postgres: 70) and its disk."""

    run_as_user: int | None = None
    fs_group: int | None = None
    storage: str = "1Gi"
    storage_class: str | None = None


@dataclass(frozen=True)
class KubernetesSpec:
    """The `kubernetes:` section."""

    namespace: str
    registry: str
    # None: the architecture of the cluster's nodes (the one the build runs on).
    platform: str | None = None
    service_account: str | None = None
    image_pull_secret: str | None = None
    env_secret: str | None = None
    node_selector: dict = field(default_factory=dict)
    redis: KubernetesRedis = field(default_factory=KubernetesRedis)
    endpoint: KubernetesEndpoint = field(default_factory=KubernetesEndpoint)
    databases: dict = field(default_factory=dict)


def _matching(
    collector, node, key, prefix, pattern, what, required=False, default=None
):
    """A string setting that must match `pattern`, described as `what` when it does not."""
    value = _string(collector, node, key, prefix, default, required)
    if value is not None and value is not default and not pattern.match(value):
        collector.add(node, key, f"{prefix}.{key}", f"must be {what}, got {value!r}")
        return default
    return value


def _redis(collector, block):
    node = _mapping(collector, block, "redis", SECTION, REDIS_KEYS)
    if node is None:
        return KubernetesRedis()
    prefix = f"{SECTION}.redis"
    host = _string(collector, node, "host", prefix)
    if host is not None:
        for key in ("storage", "storage_class"):
            if key in node:
                collector.add(
                    node,
                    key,
                    f"{prefix}.{key}",
                    "applies only to the Redis the operator runs; remove it or `host`",
                )
    else:
        for key in ("port", "tls", "password_secret"):
            if key in node:
                collector.add(
                    node,
                    key,
                    f"{prefix}.{key}",
                    "applies only to your own Redis at `host`",
                )
    return KubernetesRedis(
        storage=_matching(
            collector,
            node,
            "storage",
            prefix,
            _QUANTITY,
            "a size such as 1Gi",
            default="1Gi",
        ),
        storage_class=_string(collector, node, "storage_class", prefix),
        host=host,
        port=_port(collector, node, "port", prefix, 6379),
        tls=_boolean(collector, node, "tls", prefix, False),
        password_secret=_string(collector, node, "password_secret", prefix),
    )


def _endpoint(collector, block):
    node = _mapping(collector, block, "endpoint", SECTION, ENDPOINT_KEYS)
    if node is None:
        return KubernetesEndpoint()
    prefix = f"{SECTION}.endpoint"
    host = _matching(collector, node, "host", prefix, _DNS_NAME, "a lowercase DNS name")
    if "host" not in node:
        for key in ("ingress_class", "tls_secret"):
            if key in node:
                collector.add(
                    node,
                    key,
                    f"{prefix}.{key}",
                    "needs `host`, the name the Ingress serves",
                )
    return KubernetesEndpoint(
        host=host,
        ingress_class=_string(collector, node, "ingress_class", prefix),
        tls_secret=_string(collector, node, "tls_secret", prefix),
        url=_matching(
            collector, node, "url", prefix, _URL, "an http:// or https:// URL"
        ),
    )


def _databases(collector, block, node):
    """Per-database settings, keyed by the name of a `type: database` agent."""
    raw = block.get("databases")
    # Each key is checked below against the database agents, with its own message.
    databases_node = _mapping(
        collector,
        block,
        "databases",
        SECTION,
        set(raw) if isinstance(raw, dict) else set(),
    )
    if databases_node is None:
        return {}
    entries = node.get("agents") if isinstance(node.get("agents"), list) else []
    database_names = {
        entry.get("name")
        for entry in entries
        if isinstance(entry, dict) and entry.get("type") == "database"
    }
    databases = {}
    for name in databases_node:
        prefix = f"{SECTION}.databases.{name}"
        if name not in database_names:
            collector.add(
                databases_node,
                name,
                prefix,
                "is not an `agents:` entry of type 'database'",
            )
            continue
        settings = (
            _mapping(
                collector, databases_node, name, f"{SECTION}.databases", DATABASE_KEYS
            )
            or {}
        )
        databases[name] = KubernetesDatabase(
            run_as_user=_integer(collector, settings, "run_as_user", prefix, None, 1),
            fs_group=_integer(collector, settings, "fs_group", prefix, None, 0),
            storage=_matching(
                collector,
                settings,
                "storage",
                prefix,
                _QUANTITY,
                "a size such as 1Gi",
                default="1Gi",
            ),
            storage_class=_string(collector, settings, "storage_class", prefix),
        )
    return databases


def _agent_names(collector, node):
    """Each agent's Kubernetes name must be its own and not one of the project's.
    Read from the entries as written, so a broken entry elsewhere shifts nothing."""
    taken = {}
    entries = node.get("agents") if isinstance(node.get("agents"), list) else []
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict) or not isinstance(entry.get("name"), str):
            continue  # the agents check reports it
        try:
            name = resource_name(entry["name"])
        except ValueError:
            collector.add(
                entry,
                "name",
                f"agents[{index}].name",
                "has no letters or digits for a Kubernetes name",
            )
            continue
        if name in RESERVED_NAMES:
            collector.add(
                entry,
                "name",
                f"agents[{index}].name",
                f"becomes the Kubernetes name {name!r}, which the project itself uses; rename the agent",
            )
        elif name in taken:
            collector.add(
                entry,
                "name",
                f"agents[{index}].name",
                f"becomes the Kubernetes name {name!r}, the same as {taken[name]!r}; rename one",
            )
        else:
            taken[name] = entry["name"]


def parse_kubernetes(collector, node):
    """Parse the optional `kubernetes:` section, or return None without one."""
    block = _mapping(collector, node, SECTION, "", KEYS)
    if block is None:
        return None
    _agent_names(collector, node)
    return KubernetesSpec(
        namespace=_matching(
            collector, block, "namespace", SECTION, _DNS_LABEL,
            "a Kubernetes namespace name (lowercase letters, digits, hyphens)",
            required=True,
        ),
        registry=_string(collector, block, "registry", SECTION, required=True),
        platform=_matching(
            collector, block, "platform", SECTION, _PLATFORM, "linux/amd64 or linux/arm64",
        ),
        service_account=_string(collector, block, "service_account", SECTION),
        image_pull_secret=_string(collector, block, "image_pull_secret", SECTION),
        env_secret=_string(collector, block, "env_secret", SECTION),
        node_selector=_string_mapping(collector, block, "node_selector", SECTION),
        redis=_redis(collector, block),
        endpoint=_endpoint(collector, block),
        databases=_databases(collector, block, node),
    )  # fmt: skip
