import itertools
import os
import sys
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from canyonos_core.controller.global_controller import GlobalController
from canyonos_core.instances.endpoints import routing_endpoint_for
from canyonos_core.reconciler import state
from canyonos_core.reconciler.reconciler import Reconciler
from fakes import _bare_reconciler, _FakeProvisioner, _FakeRedis, _instance


class _RaisingRedis(_FakeRedis):
    def hgetall(self, name):
        raise RuntimeError("connection refused")


ALPHA_SPEC = {"name": "Alpha", "provider": "local", "replicas": 2}
BETA_SPEC = {"name": "Beta", "provider": "local", "replicas": 1}


def _fake_context(redis=None, agents=None, node_redis=None):
    redis = redis if redis is not None else _FakeRedis()
    agents = agents if agents is not None else [ALPHA_SPEC, BETA_SPEC]
    return SimpleNamespace(
        redis=redis,
        controllers=agents,
        agent_specs={spec["name"]: spec for spec in agents},
        config_path="/tmp/canyonos.yaml",
        node_redis_for_instance=lambda instance: node_redis or redis,
        refresh_controllers_from_redis=lambda: False,
    )


class StartupReadinessTests(unittest.TestCase):
    def _controller(self, replicas):
        controller = GlobalController.__new__(GlobalController)
        controller.controllers = [{"name": "Alpha", "replicas": replicas}]
        controller.redis = _FakeRedis()
        # _launch_redis_containers registers the local node in production
        controller.node_redis = {"localhost": controller.redis}
        controller._last_status = {}
        patcher = patch("canyonos_core.controller.global_controller.list_instances")
        self.list_instances = patcher.start()
        self.addCleanup(patcher.stop)
        return controller

    def _ready(self, controller, instance):
        """Mark an instance healthy under the key the real endpoint helper builds."""
        endpoint = routing_endpoint_for(instance)
        controller.redis.set(f"controller:{endpoint}:status", "healthy")

    def test_wait_for_healthy_tracks_instances_that_appear_asynchronously(self):
        controller = self._controller(replicas=2)
        first = _instance("Alpha", 0)
        second = _instance("Alpha", 1)
        self._ready(controller, first)
        self._ready(controller, second)
        self.list_instances.side_effect = [
            [],
            [first],
            [first, second],
        ]

        with (
            patch("canyonos_core.controller.global_controller.time.sleep") as sleep,
            self.assertLogs(
                "canyonos_core.controller.global_controller", level="INFO"
            ) as logs,
        ):
            controller._wait_for_healthy()

        self.assertEqual(self.list_instances.call_count, 3)
        self.assertEqual(sleep.call_count, 2)
        self.assertEqual(
            sum(" is ready." in message for message in logs.output),
            2,
        )
        self.assertEqual(
            controller._last_status,
            {("localhost", "8000"): "healthy", ("localhost", "8001"): "healthy"},
        )

    def test_wait_for_healthy_returns_normally_when_no_instances_appear(self):
        controller = self._controller(replicas=1)
        self.list_instances.return_value = []

        with (
            patch(
                "canyonos_core.controller.global_controller.time.time",
                side_effect=itertools.chain([0, 0], itertools.repeat(2)),
            ),
            patch("canyonos_core.controller.global_controller.time.sleep") as sleep,
            self.assertLogs(
                "canyonos_core.controller.global_controller", level="CRITICAL"
            ) as logs,
        ):
            controller._wait_for_healthy(timeout=2, interval=2)

        self.assertEqual(self.list_instances.call_count, 2)
        sleep.assert_called_once_with(2)
        self.assertIn("reconciler", logs.output[0])


class DesiredStateTests(unittest.TestCase):
    def test_get_desired_clamps_a_negative_stored_value_to_zero(self):
        redis = _FakeRedis()
        redis.set(state.desired_key("Alpha"), -2)
        self.assertEqual(state.get_desired(redis, "Alpha", default=1), 0)

    def test_get_desired_falls_back_to_the_default_on_a_non_integer_value(self):
        redis = _FakeRedis()
        redis.set(state.desired_key("Alpha"), "many")
        self.assertEqual(state.get_desired(redis, "Alpha", default=2), 2)

    def test_seed_desired_writes_the_configured_count_when_absent(self):
        redis = _FakeRedis()
        state.seed_desired(redis, [ALPHA_SPEC, BETA_SPEC])
        self.assertEqual(redis.get(state.desired_key("Alpha")), "2")
        self.assertEqual(redis.get(state.desired_key("Beta")), "1")

    def test_seed_desired_leaves_an_existing_value_untouched(self):
        """Redis stays authoritative so a runtime scale survives a controller restart."""
        redis = _FakeRedis()
        redis.set(state.desired_key("Alpha"), 7)
        state.seed_desired(redis, [ALPHA_SPEC])
        self.assertEqual(redis.get(state.desired_key("Alpha")), "7")

    def test_desired_agent_specs_returns_the_full_list_with_desired_counts(self):
        redis = _FakeRedis()
        state.set_desired(redis, "Alpha", 4)
        specs = state.desired_agent_specs(redis, [ALPHA_SPEC, BETA_SPEC])
        self.assertEqual(
            specs,
            [
                {"name": "Alpha", "provider": "local", "replicas": 4},
                {"name": "Beta", "provider": "local", "replicas": 1},
            ],
        )

    def test_desired_agent_specs_passes_through_non_integer_replicas_untouched(self):
        redis = _FakeRedis()
        placed = {"name": "Placed", "replicas": [{"host": "10.0.0.1"}]}
        specs = state.desired_agent_specs(redis, [ALPHA_SPEC, placed])

        # Dropping it would delete the service from the routing snapshot.
        self.assertEqual([spec["name"] for spec in specs], ["Alpha", "Placed"])
        self.assertEqual(specs[1]["replicas"], [{"host": "10.0.0.1"}])


class WakeQueueTests(unittest.TestCase):
    def test_drain_returns_an_empty_set_when_nothing_is_queued(self):
        self.assertEqual(state.drain(_FakeRedis(), timeout=0), set())

    def test_drain_coalesces_a_burst_of_duplicate_signals(self):
        redis = _FakeRedis()
        for _ in range(5):
            state.request_reconcile(redis, "Alpha")

        self.assertEqual(state.drain(redis, timeout=0), {"Alpha"})
        self.assertEqual(redis.lists[state.WAKE_QUEUE_KEY], [])

    def test_request_reconcile_defaults_to_the_wake_all_signal(self):
        redis = _FakeRedis()
        state.request_reconcile(redis)
        self.assertEqual(state.drain(redis, timeout=0), {state.WAKE_ALL})


class ReapRequestTests(unittest.TestCase):
    def test_only_ids_belonging_to_the_named_agent_are_returned(self):
        redis = _FakeRedis()
        state.request_replace(redis, "local:Alpha:1")
        state.request_replace(redis, "local:Beta:0")

        self.assertEqual(state.reap_requests(redis, "Alpha"), {"local:Alpha:1"})

    def test_a_request_stays_pending_until_cleared(self):
        redis = _FakeRedis()
        state.request_replace(redis, "local:Alpha:1")

        state.reap_requests(redis, "Alpha")
        self.assertEqual(state.reap_requests(redis, "Alpha"), {"local:Alpha:1"})

        state.clear_reap_requests(redis, "local:Alpha:1")
        self.assertEqual(state.reap_requests(redis, "Alpha"), set())


class ScalingEntryPointTests(unittest.TestCase):
    """The controller-side entry points; the reconciler picks the writes up on its next pass."""

    def test_the_desired_count_is_written_and_the_reconciler_woken(self):
        controller = self._controller()

        self.assertEqual(controller.set_replicas("Alpha", 4), 4)

        self.assertEqual(state.get_desired(controller.redis, "Alpha", 1), 4)
        self.assertEqual(controller.redis.lists[state.WAKE_QUEUE_KEY], ["Alpha"])

    def test_an_unknown_agent_writes_nothing(self):
        controller = self._controller(specs={})

        with self.assertLogs("canyonos_core.controller.global_controller", "WARNING"):
            self.assertIsNone(controller.set_replicas("Nope", 3))

        self.assertEqual(controller.redis.strings, {})

    def _controller(self, specs=None):
        controller = GlobalController.__new__(GlobalController)
        controller.redis = _FakeRedis()
        controller.agent_specs = specs if specs is not None else {"Alpha": ALPHA_SPEC}
        return controller

    def test_the_named_replica_is_queued_for_reaping_and_the_reconciler_woken(self):
        controller = self._controller()

        target = controller.replace_instance("Alpha", 1)

        self.assertEqual(target, "local:Alpha:1")
        self.assertEqual(
            controller.redis.smembers(state.REAP_SET_KEY), {"local:Alpha:1"}
        )
        self.assertEqual(controller.redis.lists[state.WAKE_QUEUE_KEY], ["Alpha"])

    def test_an_unknown_agent_queues_nothing(self):
        controller = self._controller(specs={})

        with self.assertLogs("canyonos_core.controller.global_controller", "WARNING"):
            self.assertIsNone(controller.replace_instance("Nope", 0))

        self.assertEqual(controller.redis.smembers(state.REAP_SET_KEY), set())


class ReconcileTests(unittest.TestCase):
    def _healthy(self, reconciler):
        """Force every health probe to pass without opening a socket."""
        patcher = patch.object(Reconciler, "_accepts_connections", return_value=True)
        patcher.start()
        self.addCleanup(patcher.stop)
        patcher = patch.object(Reconciler, "_reports_are_fresh", return_value=True)
        patcher.start()
        self.addCleanup(patcher.stop)
        return reconciler

    def test_surplus_instances_are_reaped_and_the_kept_one_is_left_alone(self):
        redis = _FakeRedis()
        state.set_desired(redis, "Alpha", 1)
        manager = _FakeProvisioner({"Alpha": [_instance("Alpha", i) for i in range(3)]})
        reconciler = self._healthy(_bare_reconciler(_fake_context(redis), manager))

        reconciler.reconcile("Alpha")

        self.assertEqual(manager.removed, ["local:Alpha:1", "local:Alpha:2"])

    def test_a_pass_provisions_specs_for_every_configured_agent(self):
        """A single-spec call would drop every other agent from the routing table."""
        redis = _FakeRedis()
        state.set_desired(redis, "Alpha", 2)
        state.set_desired(redis, "Beta", 1)
        manager = _FakeProvisioner()
        reconciler = self._healthy(_bare_reconciler(_fake_context(redis), manager))

        for target in (None, "Alpha"):
            with self.subTest(target=target):
                manager.ensure_calls.clear()
                reconciler.reconcile(target)

                # One call per pass, not one per agent: each republishes routing.
                self.assertEqual(len(manager.ensure_calls), 1)
                self.assertEqual(
                    manager.ensure_calls[0],
                    [
                        {"name": "Alpha", "provider": "local", "replicas": 2},
                        {"name": "Beta", "provider": "local", "replicas": 1},
                    ],
                )

    def test_an_unhealthy_instance_is_removed_unless_it_is_still_starting(self):
        """_is_healthy is a function of (accepts, fresh, seen_healthy, created_at)."""
        now = time.time()
        cases = [
            ("probe fails", False, True, now - 3600, set(), ["local:Alpha:0"]),
            ("starting up", False, False, now, set(), []),
            ("grace passed", False, False, now - 3600, set(), ["local:Alpha:0"]),
            (
                "no grace once seen",
                False,
                False,
                now,
                {"local:Alpha:0"},
                ["local:Alpha:0"],
            ),
        ]
        for name, accepts, fresh, created_at, seen, expected in cases:
            with self.subTest(name):
                redis = _FakeRedis()
                state.set_desired(redis, "Alpha", 1)
                manager = _FakeProvisioner(
                    {"Alpha": [_instance("Alpha", 0, created_at=created_at)]}
                )
                reconciler = _bare_reconciler(
                    _fake_context(redis), manager, _seen_healthy=set(seen)
                )

                with (
                    patch.object(
                        Reconciler, "_accepts_connections", return_value=accepts
                    ),
                    patch.object(Reconciler, "_reports_are_fresh", return_value=fresh),
                ):
                    reconciler.reconcile("Alpha")

                self.assertEqual(manager.removed, expected)
                self.assertNotIn("local:Alpha:0", reconciler._seen_healthy)

    def test_a_database_is_judged_by_its_connection_alone(self):
        for accepts, expected in ((True, []), (False, ["local:Db:0"])):
            with self.subTest(accepts=accepts):
                redis = _FakeRedis()
                manager = _FakeProvisioner(
                    {"Db": [_instance("Db", 0, created_at=time.time() - 3600)]}
                )
                context = _fake_context(
                    redis, [{"name": "Db", "type": "database", "replicas": 1}]
                )
                reconciler = _bare_reconciler(context, manager)

                with (
                    patch.object(
                        Reconciler, "_accepts_connections", return_value=accepts
                    ),
                    patch.object(Reconciler, "_reports_are_fresh", return_value=False),
                ):
                    reconciler.reconcile("Db")

                self.assertEqual(manager.removed, expected)

    def test_an_ec2_instance_is_routed_on_its_published_port(self):
        instance = {
            "provider": "EC2",
            "host": "10.0.0.5",
            "host_port": "5433",
            "container_port": "5432",
        }

        self.assertEqual(routing_endpoint_for(instance), "10.0.0.5:5433")

    def test_an_agent_with_non_integer_replicas_is_skipped_not_reaped(self):
        redis = _FakeRedis()
        manager = _FakeProvisioner()
        context = _fake_context(redis)
        context.agent_specs = {
            "Placed": {"name": "Placed", "replicas": [{"host": "h"}]}
        }
        reconciler = _bare_reconciler(context, manager)

        with self.assertLogs("canyonos_core.reconciler.reconciler", "WARNING"):
            reconciler.reconcile("Placed")

        self.assertEqual(manager.removed, [])
        self.assertEqual(manager.ensure_calls, [])

    def test_reconcile_of_an_unknown_agent_is_a_noop(self):
        manager = _FakeProvisioner()
        reconciler = _bare_reconciler(_fake_context(), manager)

        with self.assertLogs("canyonos_core.reconciler.reconciler", "WARNING"):
            reconciler.reconcile("Nope")

        self.assertEqual(manager.removed, [])
        self.assertEqual(manager.ensure_calls, [])

    def test_a_replacement_request_is_cleared_once_its_instance_is_removed(self):
        redis = _FakeRedis()
        state.set_desired(redis, "Alpha", 2)
        state.request_replace(redis, "local:Alpha:1")
        manager = _FakeProvisioner({"Alpha": [_instance("Alpha", i) for i in range(2)]})
        reconciler = self._healthy(_bare_reconciler(_fake_context(redis), manager))

        reconciler.reconcile("Alpha")

        self.assertEqual(manager.removed, ["local:Alpha:1"])
        self.assertEqual(state.reap_requests(redis, "Alpha"), set())

    def test_a_replacement_request_survives_a_failed_removal(self):
        redis = _FakeRedis()
        state.set_desired(redis, "Alpha", 2)
        state.request_replace(redis, "local:Alpha:1")
        manager = _FakeProvisioner(
            {"Alpha": [_instance("Alpha", i) for i in range(2)]}, remove_raises=True
        )
        reconciler = self._healthy(_bare_reconciler(_fake_context(redis), manager))

        with self.assertLogs("canyonos_core.reconciler.reconciler", "WARNING"):
            reconciler.reconcile("Alpha")

        self.assertEqual(state.reap_requests(redis, "Alpha"), {"local:Alpha:1"})

    def test_a_replacement_request_for_a_missing_instance_is_dropped(self):
        redis = _FakeRedis()
        state.set_desired(redis, "Alpha", 2)
        state.request_replace(redis, "local:Alpha:7")
        manager = _FakeProvisioner({"Alpha": [_instance("Alpha", 0)]})
        reconciler = self._healthy(_bare_reconciler(_fake_context(redis), manager))

        reconciler.reconcile("Alpha")

        self.assertEqual(state.reap_requests(redis, "Alpha"), set())

    def test_a_full_pass_reaps_instances_of_an_agent_removed_from_the_config(self):
        redis = _FakeRedis()
        state.set_desired(redis, "Alpha", 1)
        manager = _FakeProvisioner(
            {"Alpha": [_instance("Alpha", 0)], "Gone": [_instance("Gone", 0)]}
        )
        context = _fake_context(redis, agents=[{**ALPHA_SPEC, "replicas": 1}])
        reconciler = self._healthy(_bare_reconciler(context, manager))

        reconciler.reconcile("Alpha")
        self.assertEqual(manager.removed, [])

        reconciler.reconcile()
        self.assertEqual(manager.removed, ["local:Gone:0"])

    def test_full_pass_keeps_going_when_one_agent_raises(self):
        redis = _FakeRedis()
        state.set_desired(redis, "Alpha", 0)
        state.set_desired(redis, "Beta", 0)
        manager = _FakeProvisioner(raise_for="Alpha")
        reconciler = self._healthy(_bare_reconciler(_fake_context(redis), manager))

        with self.assertLogs("canyonos_core.reconciler.reconciler", "WARNING"):
            reconciler.reconcile()

        self.assertEqual(len(manager.ensure_calls), 1)


class ConnectionProbeTests(unittest.TestCase):
    def _probed_address(self, instance, env):
        reconciler = _bare_reconciler(_fake_context(), _FakeProvisioner())
        with (
            patch.dict(os.environ, env, clear=False),
            patch(
                "canyonos_core.reconciler.reconciler.socket.create_connection"
            ) as connect,
        ):
            if "CANYONOS_REDIS_HOST" not in env:
                os.environ.pop("CANYONOS_REDIS_HOST", None)
            self.assertTrue(reconciler._accepts_connections(instance))
        return connect.call_args.args[0]

    def test_a_containerized_reconciler_probes_local_ports_via_the_host_gateway(self):
        address = self._probed_address(
            _instance("Alpha", 0), {"CANYONOS_REDIS_HOST": "host.docker.internal"}
        )

        self.assertEqual(address, ("host.docker.internal", 8000))

    def test_a_reconciler_on_the_host_probes_localhost(self):
        self.assertEqual(
            self._probed_address(_instance("Alpha", 0), {}), ("localhost", 8000)
        )

    def test_a_remote_host_is_probed_directly(self):
        instance = {**_instance("Alpha", 0), "host": "10.0.0.5"}

        address = self._probed_address(
            instance, {"CANYONOS_REDIS_HOST": "host.docker.internal"}
        )

        self.assertEqual(address, ("10.0.0.5", 8000))


class ReportFreshnessTests(unittest.TestCase):
    def _reconciler(self, node_redis):
        context = _fake_context(node_redis=node_redis)
        return _bare_reconciler(context, _FakeProvisioner())

    def _metrics_key(self, instance):
        """Spelled the way the agent's own LocalController writes it, not the record."""
        return (
            f"controller:{instance['runtime_id']}:{instance['container_port']}:metrics"
        )

    def test_a_recent_updated_at_is_fresh(self):
        instance = _instance("Alpha", 0)
        node_redis = _FakeRedis()
        node_redis.hset(self._metrics_key(instance), "updated_at", time.time())

        self.assertTrue(self._reconciler(node_redis)._reports_are_fresh(instance))

    def test_an_updated_at_older_than_stale_after_is_not_fresh(self):
        instance = _instance("Alpha", 0)
        node_redis = _FakeRedis()
        node_redis.hset(self._metrics_key(instance), "updated_at", time.time() - 3600)

        self.assertFalse(self._reconciler(node_redis)._reports_are_fresh(instance))

    def test_a_missing_metrics_hash_is_not_fresh(self):
        self.assertFalse(
            self._reconciler(_FakeRedis())._reports_are_fresh(_instance("Alpha", 0))
        )

    def test_a_redis_blip_is_not_read_as_an_unhealthy_instance(self):
        reconciler = self._reconciler(_RaisingRedis())

        with self.assertLogs("canyonos_core.reconciler.reconciler", "WARNING"):
            self.assertTrue(reconciler._reports_are_fresh(_instance("Alpha", 0)))


class DrainingFlagTests(unittest.TestCase):
    def test_nothing_is_draining_by_default(self):
        self.assertFalse(state.is_draining(_FakeRedis()))

    def test_set_draining_is_visible_and_carries_a_ttl(self):
        redis = _FakeRedis()
        state.set_draining(redis)

        self.assertTrue(state.is_draining(redis))
        self.assertEqual(redis.ttls[state.DRAINING_KEY], state.DRAINING_TTL_SECONDS)

    def test_clear_draining_removes_the_flag(self):
        redis = _FakeRedis()
        state.set_draining(redis)
        state.clear_draining(redis)

        self.assertFalse(state.is_draining(redis))

    def test_draining_leaves_desired_replicas_untouched(self):
        """seed_desired is write-if-absent, so a zero persisted here would outlive teardown."""
        redis = _FakeRedis()
        state.set_desired(redis, "Alpha", 3)

        state.set_draining(redis)
        state.clear_draining(redis)

        self.assertEqual(state.get_desired(redis, "Alpha"), 3)


class DrainReconcileTests(unittest.TestCase):
    def _reconciler(self, redis, manager):
        patcher = patch.object(Reconciler, "_accepts_connections", return_value=True)
        patcher.start()
        self.addCleanup(patcher.stop)
        patcher = patch.object(Reconciler, "_reports_are_fresh", return_value=True)
        patcher.start()
        self.addCleanup(patcher.stop)
        return _bare_reconciler(_fake_context(redis), manager)

    def test_draining_reaps_every_instance_regardless_of_desired(self):
        redis = _FakeRedis()
        state.set_desired(redis, "Alpha", 3)
        state.set_draining(redis)
        manager = _FakeProvisioner({"Alpha": [_instance("Alpha", i) for i in range(3)]})

        self._reconciler(redis, manager).reconcile("Alpha")

        self.assertEqual(
            manager.removed, ["local:Alpha:0", "local:Alpha:1", "local:Alpha:2"]
        )
        # desired_agent_specs falls back to the configured count, so a fill would undo it.
        self.assertEqual(manager.ensure_calls, [])

    def test_full_pass_drains_every_agent_and_fills_nothing(self):
        redis = _FakeRedis()
        state.set_draining(redis)
        manager = _FakeProvisioner(
            {"Alpha": [_instance("Alpha", 0)], "Beta": [_instance("Beta", 0)]}
        )

        self._reconciler(redis, manager).reconcile()

        self.assertEqual(sorted(manager.removed), ["local:Alpha:0", "local:Beta:0"])
        self.assertEqual(manager.ensure_calls, [])

    def test_draining_reaps_an_agent_whose_replicas_is_not_a_count(self):
        """The non-integer guard skips reaping, but a teardown still has to remove it."""
        redis = _FakeRedis()
        state.set_draining(redis)
        agents = [{"name": "Alpha", "provider": "local", "replicas": [["host", 9000]]}]
        manager = _FakeProvisioner({"Alpha": [_instance("Alpha", 0)]})
        reconciler = _bare_reconciler(_fake_context(redis, agents=agents), manager)

        reconciler.reconcile()

        self.assertEqual(manager.removed, ["local:Alpha:0"])

    def test_clearing_the_flag_returns_the_loop_to_desired_state(self):
        redis = _FakeRedis()
        state.set_desired(redis, "Alpha", 1)
        state.set_draining(redis)
        state.clear_draining(redis)
        manager = _FakeProvisioner({"Alpha": [_instance("Alpha", 0)]})

        self._reconciler(redis, manager).reconcile("Alpha")

        self.assertEqual(manager.removed, [])
        self.assertEqual(len(manager.ensure_calls), 1)


if __name__ == "__main__":
    unittest.main()
