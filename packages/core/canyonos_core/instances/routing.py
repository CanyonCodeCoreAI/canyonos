"""
Publish the routing table other parts of CanyonOS use to reach agents.

The spec list given is the complete world: every service absent from it is
removed, so callers must pass specs for every configured agent.
"""

import json

from canyonos_core.instances.endpoints import routing_endpoint_for
from canyonos_core.instances.records import list_instances

ROUTING_ENDPOINTS_KEY = "routing_table:endpoints"
ROUTING_STATEFUL_KEY = "routing_table:stateful"
SERVICES_SET_KEY = "routing_table:services"


def publish_routing_snapshot(agent_specs, primary_redis, node_redis=None):
    services = {agent_spec["name"] for agent_spec in agent_specs}
    stateful = {
        agent_spec["name"]
        for agent_spec in agent_specs
        if agent_spec.get("stateful", False)
    }
    targets = list((node_redis or {}).values()) or [primary_redis]

    for redis_client in targets:
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
                redis_client.hset(ROUTING_ENDPOINTS_KEY, service, json.dumps(endpoints))
            else:
                redis_client.hdel(ROUTING_ENDPOINTS_KEY, service)
