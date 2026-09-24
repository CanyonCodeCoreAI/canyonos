"""Publish the routing table; the spec list given is the complete world."""

import json
import logging

from canyonos_core.controller.controller_context import (
    list_instances,
    routing_endpoint_for,
)

logger = logging.getLogger(__name__)

ROUTING_ENDPOINTS_KEY = "routing_table:endpoints"
ROUTING_STATEFUL_KEY = "routing_table:stateful"
SERVICES_SET_KEY = "routing_table:services"


def publish_routing_snapshot(agent_specs, primary_redis, node_redis=None):
    """Write every agent's replica addresses to each node's Redis, removing agents not in agent_specs."""
    services = {agent_spec["name"] for agent_spec in agent_specs}
    stateful = {
        agent_spec["name"]
        for agent_spec in agent_specs
        if agent_spec.get("stateful", False)
    }
    targets = list((node_redis or {}).values()) or [primary_redis]

    for redis_client in targets:
        try:
            existing_services = redis_client.smembers(SERVICES_SET_KEY)
            for stale in existing_services - services:
                redis_client.srem(SERVICES_SET_KEY, stale)
                redis_client.hdel(ROUTING_STATEFUL_KEY, stale)
                redis_client.hdel(ROUTING_ENDPOINTS_KEY, stale)
            for service in services:
                redis_client.sadd(SERVICES_SET_KEY, service)
                if service in stateful:
                    redis_client.hset(ROUTING_STATEFUL_KEY, service, "true")
                else:
                    redis_client.hdel(ROUTING_STATEFUL_KEY, service)
                endpoints = [
                    routing_endpoint_for(item)
                    for item in sorted(
                        list_instances(primary_redis, service),
                        key=lambda item: int(item["replica_index"]),
                    )
                ]
                if endpoints:
                    redis_client.hset(
                        ROUTING_ENDPOINTS_KEY, service, json.dumps(endpoints)
                    )
                else:
                    redis_client.hdel(ROUTING_ENDPOINTS_KEY, service)
        except Exception as e:
            logger.warning("Failed to publish routing to a node's Redis: %s", e)
