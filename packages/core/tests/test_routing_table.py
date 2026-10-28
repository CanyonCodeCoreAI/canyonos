# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""The routing table: how one agent finds another's gRPC address, published by the reconciler."""

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import canyonos_core.controller.global_controller as global_controller_module
from canyonos_core.controller.global_controller import GlobalController
from canyonos_core.reconciler.routing import (
    ROUTING_ADDRESSES_KEY,
    ROUTING_STATEFUL_KEY,
    AGENTS_SET_KEY,
    publish_routing_snapshot,
)

from fakes import _FakeRedis

ALPHA = {"name": "Alpha", "provider": "local"}
BETA = {"name": "Beta", "provider": "local", "stateful": True}


def _seed(redis, agent_name, n):
    replica_id = f"local:{agent_name}:{n}"
    redis.sadd(f"agent:{agent_name}:instances", replica_id)
    redis.hashes[f"agent_instance:{replica_id}"] = {
        "agent_name": agent_name,
        "provider": "local",
        "replica_id": replica_id,
        "created_at": str(n),
        "private_host": "localhost",
        "public_host": "localhost",
        "host_port": str(8000 + n),
        "container_port": "50051",
        "published_address": f"localhost:{8000 + n}",
        "address": f"canyonos-{agent_name.lower()}-{n}:50051",
        "container_name": f"canyonos-{agent_name.lower()}-{n}",
    }


class PublishTests(unittest.TestCase):
    def test_agents_addresses_and_stateful_are_all_written(self):
        redis = _FakeRedis()
        _seed(redis, "Alpha", 0)
        _seed(redis, "Beta", 0)

        publish_routing_snapshot([ALPHA, BETA], redis)

        self.assertEqual(redis.smembers(AGENTS_SET_KEY), {"Alpha", "Beta"})
        self.assertEqual(
            json.loads(redis.hget(ROUTING_ADDRESSES_KEY, "Alpha")),
            ["canyonos-alpha-0:50051"],
        )
        self.assertEqual(redis.hget(ROUTING_STATEFUL_KEY, "Beta"), "true")
        self.assertIsNone(redis.hget(ROUTING_STATEFUL_KEY, "Alpha"))

    def test_endpoints_are_ordered_by_creation_time_not_insertion(self):
        """Clients round-robin over this list, so the order has to be stable."""
        redis = _FakeRedis()
        for index in (2, 0, 1):
            _seed(redis, "Alpha", index)

        publish_routing_snapshot([ALPHA], redis)

        self.assertEqual(
            json.loads(redis.hget(ROUTING_ADDRESSES_KEY, "Alpha")),
            [
                "canyonos-alpha-0:50051",
                "canyonos-alpha-1:50051",
                "canyonos-alpha-2:50051",
            ],
        )

    def test_a_draining_replica_is_left_out(self):
        redis = _FakeRedis()
        _seed(redis, "Alpha", 0)
        _seed(redis, "Alpha", 1)
        redis.hset("agent_instance:local:Alpha:1", "draining_at", "2")

        publish_routing_snapshot([ALPHA], redis)

        self.assertEqual(
            json.loads(redis.hget(ROUTING_ADDRESSES_KEY, "Alpha")),
            ["canyonos-alpha-0:50051"],
        )

    def test_an_agent_missing_from_the_specs_is_removed_everywhere(self):
        """The spec list is the complete world, so the fill step must pass every agent's."""
        redis = _FakeRedis()
        _seed(redis, "Alpha", 0)
        _seed(redis, "Beta", 0)
        publish_routing_snapshot([ALPHA, BETA], redis)

        publish_routing_snapshot([ALPHA], redis)

        self.assertEqual(redis.smembers(AGENTS_SET_KEY), {"Alpha"})
        self.assertIsNone(redis.hget(ROUTING_ADDRESSES_KEY, "Beta"))
        self.assertIsNone(redis.hget(ROUTING_STATEFUL_KEY, "Beta"))

    def test_an_agent_with_no_replicas_is_listed_but_has_no_addresses(self):
        """Configured but nothing running; a missing entry correctly means "no route"."""
        redis = _FakeRedis()

        publish_routing_snapshot([ALPHA], redis)

        self.assertEqual(redis.smembers(AGENTS_SET_KEY), {"Alpha"})
        self.assertIsNone(redis.hget(ROUTING_ADDRESSES_KEY, "Alpha"))

    def test_an_agent_that_stops_being_stateful_loses_the_flag(self):
        redis = _FakeRedis()
        _seed(redis, "Beta", 0)
        publish_routing_snapshot([BETA], redis)

        publish_routing_snapshot([{"name": "Beta", "provider": "local"}], redis)

        self.assertIsNone(redis.hget(ROUTING_STATEFUL_KEY, "Beta"))

    def test_every_machine_gets_a_copy_while_records_come_from_the_primary(self):
        """Records live on the primary, so a machine client with no records still gets the table."""
        primary = _FakeRedis()
        machine_a, machine_b = _FakeRedis(), _FakeRedis()
        _seed(primary, "Alpha", 0)

        publish_routing_snapshot(
            [ALPHA], primary, {"host-a": machine_a, "host-b": machine_b}
        )

        for machine in (machine_a, machine_b):
            self.assertEqual(machine.smembers(AGENTS_SET_KEY), {"Alpha"})
            self.assertEqual(
                json.loads(machine.hget(ROUTING_ADDRESSES_KEY, "Alpha")),
                ["canyonos-alpha-0:50051"],
            )
        self.assertEqual(primary.smembers(AGENTS_SET_KEY), set())

    def test_an_empty_machine_map_falls_back_to_the_primary(self):
        redis = _FakeRedis()
        _seed(redis, "Alpha", 0)

        publish_routing_snapshot([ALPHA], redis, {})

        self.assertEqual(redis.smembers(AGENTS_SET_KEY), {"Alpha"})


class OwnershipTests(unittest.TestCase):
    def test_the_controller_does_not_publish_the_routing_table(self):
        """Routing is derived from what exists, so it belongs to the provisioning process."""
        self.assertFalse(hasattr(global_controller_module, "publish_routing_snapshot"))
        self.assertFalse(hasattr(GlobalController, "_publish_routing"))


if __name__ == "__main__":
    unittest.main()
