# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""What the deployed project runs, read where the product keeps it: the replica
records and routing table the reconciler writes to the project's Redis, the
futures of a request, the agents' state in `canyonos status --json`, and their
replica containers in Docker. Cases use it to pick a replica the way callers do and
to tell which replica ran each call of a request."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import cast

import redis

from .harness import canyonos, project_containers, redis_port

ROUTING_ADDRESSES_KEY = "routing_table:addresses"


def store(recorder, deployed) -> redis.Redis:
    """The deployed project's Redis, on the host port the CLI recorded for it."""
    return redis.Redis(
        host="127.0.0.1",
        port=redis_port(recorder, deployed.dir),
        decode_responses=True,
    )


def _hash(redis_client: redis.Redis, key: str) -> dict[str, str]:
    return cast(dict[str, str], redis_client.hgetall(key))


def _members(redis_client: redis.Redis, key: str) -> list[str]:
    return sorted(cast(set[str], redis_client.smembers(key)))


@dataclass(frozen=True)
class Replica:
    """One replica as the reconciler recorded it."""

    replica_id: str
    container: str
    address: str


def routed_replicas(redis_client: redis.Redis, agent: str) -> list[Replica]:
    """The replicas of `agent` that callers are sent to: the ones in the routing
    table, which leaves out a replica being drained or not launched yet."""
    routed = json.loads(redis_client.hget(ROUTING_ADDRESSES_KEY, agent) or "[]")
    replicas = []
    for replica_id in _members(redis_client, f"agent:{agent}:instances"):
        record = _hash(redis_client, f"agent_instance:{replica_id}")
        if record.get("address") in routed and "draining_at" not in record:
            replicas.append(
                Replica(replica_id, record["container_name"], record["address"])
            )
    return replicas


@dataclass(frozen=True)
class Call:
    """One call a request made: its `<Agent>.<function>`, the replica that ran it
    (None until that replica finished it) and the prompt version the LLM gateway
    sent with it, if any."""

    future_id: str
    label: str
    replica_id: str | None
    parent: str | None
    prompt_version: str | None


def calls_of(redis_client: redis.Redis, request_id: str) -> list[Call]:
    """Every call of the request still in Redis: the endpoint's call and each one an
    agent made. Empty once the request's cleanup expired them."""
    calls = []
    for future_id in _members(redis_client, f"request:{request_id}:futures"):
        future = _hash(redis_client, f"future:{future_id}")
        if not future:
            continue
        calls.append(
            Call(
                future_id=future_id,
                label=f"{future.get('service')}.{future.get('method')}",
                replica_id=future.get("agent") or None,
                parent=future.get("parent") or None,
                prompt_version=future.get("prompt_version") or None,
            )
        )
    return calls


def root_future(redis_client: redis.Redis, request_id: str) -> dict:
    """The hash of the call the endpoint made for the request, empty when gone."""
    future_id = redis_client.get(f"request:{request_id}:future")
    return _hash(redis_client, f"future:{future_id}") if future_id else {}


def agent_status(recorder, deployed, agent: str) -> tuple[int, int, str | None]:
    """`agent`'s desired and running replica counts and its launch error, from one
    `canyonos status --json`."""
    call = canyonos(recorder, ["status", "--json"], cwd=deployed.dir)
    spec = call.json()["agents"][agent]
    return spec["desired_replicas"], spec["running_replicas"], spec["launch_error"]


def replica_containers(recorder, deployed, agent: str) -> dict[str, str]:
    """`agent`'s replica containers by name with their state, stopped ones too."""
    pattern = re.compile(rf"{re.escape(deployed.group)}-{agent.lower()}-[0-9a-f]{{8}}")
    return {
        name: state
        for name, state in project_containers(
            recorder, deployed.group, every=True
        ).items()
        if pattern.fullmatch(name)
    }
