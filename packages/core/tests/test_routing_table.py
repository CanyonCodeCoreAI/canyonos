"""The routing table: how one agent finds another's gRPC address, published by the reconciler."""

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import canyonos_core.controller.global_controller as global_controller_module
from canyonos_core.controller.global_controller import GlobalController
from canyonos_core.reconciler.routing import (
    ROUTING_ENDPOINTS_KEY,
    ROUTING_STATEFUL_KEY,
    SERVICES_SET_KEY,
    publish_routing_snapshot,
)

from fakes import _FakeRedis

ALPHA = {"name": "Alpha", "provider": "local"}
BETA = {"name": "Beta", "provider": "local", "stateful": True}


def _seed(redis, agent_name, replica_index):
    instance_id = f"local:{agent_name}:{replica_index}"
    redis.sadd(f"agent:{agent_name}:instances", instance_id)
    redis.hashes[f"agent_instance:{instance_id}"] = {
        "agent_name": agent_name,
        "provider": "local",
        "replica_index": str(replica_index),
        "host": "localhost",
        "host_port": str(8000 + replica_index),
        "container_port": "50051",
        "runtime_id": f"canyonos-{agent_name.lower()}-{replica_index}",
    }


class PublishTests(unittest.TestCase):
    def test_services_endpoints_and_stateful_are_all_written(self):
        redis = _FakeRedis()
        _seed(redis, "Alpha", 0)
        _seed(redis, "Beta", 0)

        publish_routing_snapshot([ALPHA, BETA], redis)

        self.assertEqual(redis.smembers(SERVICES_SET_KEY), {"Alpha", "Beta"})
        self.assertEqual(
            json.loads(redis.hget(ROUTING_ENDPOINTS_KEY, "Alpha")),
            ["canyonos-alpha-0:50051"],
        )
        self.assertEqual(redis.hget(ROUTING_STATEFUL_KEY, "Beta"), "true")
        self.assertIsNone(redis.hget(ROUTING_STATEFUL_KEY, "Alpha"))

    def test_endpoints_are_ordered_by_replica_index_not_insertion(self):
        """Clients round-robin over this list, so the order has to be stable."""
        redis = _FakeRedis()
        for index in (2, 0, 1):
            _seed(redis, "Alpha", index)

        publish_routing_snapshot([ALPHA], redis)

        self.assertEqual(
            json.loads(redis.hget(ROUTING_ENDPOINTS_KEY, "Alpha")),
            [
                "canyonos-alpha-0:50051",
                "canyonos-alpha-1:50051",
                "canyonos-alpha-2:50051",
            ],
        )

    def test_a_service_missing_from_the_specs_is_removed_everywhere(self):
        """The spec list is the complete world, so the fill step must pass every agent's."""
        redis = _FakeRedis()
        _seed(redis, "Alpha", 0)
        _seed(redis, "Beta", 0)
        publish_routing_snapshot([ALPHA, BETA], redis)

        publish_routing_snapshot([ALPHA], redis)

        self.assertEqual(redis.smembers(SERVICES_SET_KEY), {"Alpha"})
        self.assertIsNone(redis.hget(ROUTING_ENDPOINTS_KEY, "Beta"))
        self.assertIsNone(redis.hget(ROUTING_STATEFUL_KEY, "Beta"))

    def test_a_service_with_no_instances_is_listed_but_has_no_endpoints(self):
        """Configured but nothing running; a missing entry correctly means "no route"."""
        redis = _FakeRedis()

        publish_routing_snapshot([ALPHA], redis)

        self.assertEqual(redis.smembers(SERVICES_SET_KEY), {"Alpha"})
        self.assertIsNone(redis.hget(ROUTING_ENDPOINTS_KEY, "Alpha"))

    def test_an_agent_that_stops_being_stateful_loses_the_flag(self):
        redis = _FakeRedis()
        _seed(redis, "Beta", 0)
        publish_routing_snapshot([BETA], redis)

        publish_routing_snapshot([{"name": "Beta", "provider": "local"}], redis)

        self.assertIsNone(redis.hget(ROUTING_STATEFUL_KEY, "Beta"))

    def test_every_node_gets_a_copy_while_records_come_from_the_primary(self):
        """Records live on the primary, so a node client with no records still gets the table."""
        primary = _FakeRedis()
        node_a, node_b = _FakeRedis(), _FakeRedis()
        _seed(primary, "Alpha", 0)

        publish_routing_snapshot([ALPHA], primary, {"host-a": node_a, "host-b": node_b})

        for node in (node_a, node_b):
            self.assertEqual(node.smembers(SERVICES_SET_KEY), {"Alpha"})
            self.assertEqual(
                json.loads(node.hget(ROUTING_ENDPOINTS_KEY, "Alpha")),
                ["canyonos-alpha-0:50051"],
            )
        self.assertEqual(primary.smembers(SERVICES_SET_KEY), set())

    def test_an_empty_node_map_falls_back_to_the_primary(self):
        redis = _FakeRedis()
        _seed(redis, "Alpha", 0)

        publish_routing_snapshot([ALPHA], redis, {})

        self.assertEqual(redis.smembers(SERVICES_SET_KEY), {"Alpha"})


class OwnershipTests(unittest.TestCase):
    def test_the_controller_does_not_publish_the_routing_table(self):
        """Routing is derived from what exists, so it belongs to the provisioning process."""
        self.assertFalse(hasattr(global_controller_module, "publish_routing_snapshot"))
        self.assertFalse(hasattr(GlobalController, "_publish_routing"))


if __name__ == "__main__":
    unittest.main()
