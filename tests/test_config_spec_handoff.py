"""The agent spec is handed off through Redis, not re-parsed from YAML twice.

Before this, ControllerContext parsed the YAML itself, so an agent added by a
SIGHUP reload was known to the controller and invisible to the reconciler: _reap
bailed on "unknown agent" and the fill step iterated a stale list.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from canyonos_core.controller.controller_context import ControllerContext
from canyonos_core.controller.utils.config_specs import (
    ACTIVE_AGENTS_KEY,
    read_config_specs,
    spec_key,
    write_config_specs,
)

from test_reconciler import _FakeRedis

ALPHA = {"name": "Alpha", "provider": "local", "replicas": 2, "image": "alpha:latest"}
BETA = {"name": "Beta", "provider": "local", "replicas": 1}


class WriteAndReadTests(unittest.TestCase):
    def test_a_written_spec_reads_back_whole(self):
        redis = _FakeRedis()
        write_config_specs([ALPHA, BETA], redis)

        self.assertEqual(read_config_specs(redis), [ALPHA, BETA])

    def test_nested_and_non_string_fields_survive_the_round_trip(self):
        redis = _FakeRedis()
        spec = {
            "name": "Alpha",
            "replicas": [{"host": "10.0.0.1", "port": 9000}],
            "resources": {"cpu": 2, "memory": 1024},
            "stateful": True,
        }
        write_config_specs([spec], redis)

        self.assertEqual(read_config_specs(redis), [spec])

    def test_nothing_published_reads_as_none_not_empty(self):
        """None and [] must not be conflated: [] would mean "no agents configured"."""
        self.assertIsNone(read_config_specs(_FakeRedis()))

    def test_the_agent_list_is_written_after_the_specs(self):
        """Torn-read guard: a reader takes the list first, so a spec still being
        written is simply not listed yet."""
        redis = _FakeRedis()
        order = []
        real_set, real_sadd = redis.set, redis.sadd
        redis.set = lambda k, v: (order.append(("set", k)), real_set(k, v))[1]
        redis.sadd = lambda n, *v: (order.append(("sadd", n)), real_sadd(n, *v))[1]

        write_config_specs([ALPHA, BETA], redis)

        self.assertEqual(order[-1], ("sadd", ACTIVE_AGENTS_KEY))
        self.assertIn(("set", spec_key("Alpha")), order)

    def test_an_agent_dropped_from_the_config_is_unpublished(self):
        redis = _FakeRedis()
        write_config_specs([ALPHA, BETA], redis)

        write_config_specs([ALPHA], redis)

        self.assertEqual(read_config_specs(redis), [ALPHA])
        self.assertEqual(redis.smembers(ACTIVE_AGENTS_KEY), {"Alpha"})
        self.assertIsNone(redis.get(spec_key("Beta")))


class RefreshTests(unittest.TestCase):
    def _context(self, redis, agents):
        context = ControllerContext.__new__(ControllerContext)
        context.redis = redis
        context._set_controllers(agents)
        return context

    def test_published_specs_replace_the_ones_loaded_at_construction(self):
        redis = _FakeRedis()
        write_config_specs([ALPHA, BETA], redis)
        context = self._context(redis, [ALPHA])

        self.assertTrue(context.refresh_controllers_from_redis())
        self.assertEqual(context.controllers, [ALPHA, BETA])
        self.assertEqual(sorted(context.agent_specs), ["Alpha", "Beta"])

    def test_an_unchanged_spec_reports_no_refresh(self):
        redis = _FakeRedis()
        write_config_specs([ALPHA], redis)
        context = self._context(redis, [ALPHA])

        self.assertFalse(context.refresh_controllers_from_redis())

    def test_an_unseeded_redis_leaves_the_current_specs_in_place(self):
        """Absent specs must not read as "no agents"; that would reap the fleet."""
        context = self._context(_FakeRedis(), [ALPHA])

        self.assertFalse(context.refresh_controllers_from_redis())
        self.assertEqual(context.controllers, [ALPHA])

    def test_a_redis_failure_leaves_the_current_specs_in_place(self):
        class _Boom(_FakeRedis):
            def smembers(self, name):
                raise RuntimeError("connection refused")

        context = self._context(_Boom(), [ALPHA])

        with self.assertLogs("canyonos_core.controller.controller_context", "WARNING"):
            self.assertFalse(context.refresh_controllers_from_redis())
        self.assertEqual(context.controllers, [ALPHA])

    def test_a_removed_agent_disappears_from_the_refreshed_specs(self):
        redis = _FakeRedis()
        write_config_specs([ALPHA, BETA], redis)
        context = self._context(redis, [ALPHA, BETA])

        write_config_specs([ALPHA], redis)

        self.assertTrue(context.refresh_controllers_from_redis())
        self.assertEqual(context.agent_specs, {"Alpha": ALPHA})


class ReloadPropagationTests(unittest.TestCase):
    """End to end: a reload adds an agent and the reconciler picks it up with no
    reload signal of its own. This is the gap that made _reap's unknown-agent
    branch reachable."""

    def _reconciler(self, redis, agents, manager):
        from unittest.mock import patch

        from canyonos_core.reconciler.reconciler import Reconciler

        context = ControllerContext.__new__(ControllerContext)
        context.redis = redis
        context.config_path = "/tmp/canyonos.yaml"
        context.node_redis_for_instance = lambda instance: redis
        context._agent_host_key = lambda host: host
        context._set_controllers(agents)

        self.enterContext(
            patch.object(Reconciler, "_accepts_connections", return_value=True)
        )
        self.enterContext(
            patch.object(Reconciler, "_reports_are_fresh", return_value=True)
        )
        reconciler = Reconciler.__new__(Reconciler)
        reconciler.context = context
        reconciler.provisioner = manager
        reconciler.sweep_interval = 5
        reconciler.stale_after = 15
        reconciler.startup_grace = 30
        reconciler._seen_healthy = set()
        return reconciler

    def test_an_agent_added_by_a_reload_is_provisioned_without_a_reload_signal(self):
        from test_reconciler import _FakeProvisioner

        redis = _FakeRedis()
        write_config_specs([ALPHA], redis)
        manager = _FakeProvisioner()
        reconciler = self._reconciler(redis, [ALPHA], manager)

        write_config_specs([ALPHA, BETA], redis)
        reconciler.reconcile()

        self.assertEqual(
            [spec["name"] for spec in manager.ensure_calls[-1]], ["Alpha", "Beta"]
        )

    def test_a_wake_for_a_newly_added_agent_is_no_longer_unknown(self):
        from test_reconciler import _FakeProvisioner

        redis = _FakeRedis()
        write_config_specs([ALPHA], redis)
        reconciler = self._reconciler(redis, [ALPHA], _FakeProvisioner())

        write_config_specs([ALPHA, BETA], redis)
        with self.assertNoLogs("canyonos_core.reconciler.reconciler", "WARNING"):
            reconciler.reconcile("Beta")


if __name__ == "__main__":
    unittest.main()
