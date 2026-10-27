# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Publish the routing table; the spec list given is the complete world."""

import json
import logging

from canyonos_core.controller.controller_context import list_replicas

logger = logging.getLogger(__name__)

# Where new calls go: a draining replica leaves this list as soon as its drain starts.
ROUTING_ADDRESSES_KEY = "routing_table:addresses"
ROUTING_STATEFUL_KEY = "routing_table:stateful"
# Every replica that still exists, draining ones too, so their running calls can finish.
ROUTING_REPLICAS_KEY = "routing_table:replicas"
AGENTS_SET_KEY = "routing_table:agents"


def publish_routing_snapshot(agent_specs, primary_redis, machine_redis=None):
    """Write every agent's replica addresses to each machine's Redis, leaving out agents
    not in agent_specs and draining replicas."""
    agent_names = {agent_spec["name"] for agent_spec in agent_specs}
    stateful = {
        agent_spec["name"]
        for agent_spec in agent_specs
        if agent_spec.get("stateful", False)
    }
    targets = list((machine_redis or {}).values()) or [primary_redis]

    for redis_client in targets:
        try:
            existing_agents = redis_client.smembers(AGENTS_SET_KEY)
            for stale in existing_agents - agent_names:
                redis_client.srem(AGENTS_SET_KEY, stale)
                redis_client.hdel(ROUTING_STATEFUL_KEY, stale)
                redis_client.hdel(ROUTING_ADDRESSES_KEY, stale)
                redis_client.hdel(ROUTING_REPLICAS_KEY, stale)
            for agent_name in agent_names:
                redis_client.sadd(AGENTS_SET_KEY, agent_name)
                if agent_name in stateful:
                    redis_client.hset(ROUTING_STATEFUL_KEY, agent_name, "true")
                else:
                    redis_client.hdel(ROUTING_STATEFUL_KEY, agent_name)
                # Each item is one replica's record: a str-to-str dict from its Redis hash.
                addresses = [
                    item["address"]
                    for item in sorted(
                        list_replicas(primary_redis, agent_name),
                        key=lambda item: int(item["replica_index"]),
                    )
                    if "draining_at" not in item
                ]
                known = [
                    item["address"] for item in list_replicas(primary_redis, agent_name)
                ]
                redis_client.hset(ROUTING_REPLICAS_KEY, agent_name, json.dumps(known))
                if addresses:
                    redis_client.hset(
                        ROUTING_ADDRESSES_KEY, agent_name, json.dumps(addresses)
                    )
                else:
                    redis_client.hdel(ROUTING_ADDRESSES_KEY, agent_name)
        except Exception as e:
            logger.warning("Failed to publish routing to a machine's Redis: %s", e)
