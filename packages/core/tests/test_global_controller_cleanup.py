# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

import json
import os
import subprocess
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
sys.path.insert(
    0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "grpc_stubs"))
)

from canyonos_core.controller.global_controller import (
    CLEANUP_RESEND_SECONDS,
    GlobalController,
)
from fakes import _FakeRedis
import local_controller_pb2


class _FakeStub:
    def __init__(self):
        self.calls = []

    def Cleanup(self, request):
        self.calls.append(json.loads(request.response))
        return local_controller_pb2.JsonResponse(response="Cleanup triggered")


class _SpyRedis(_FakeRedis):
    """_FakeRedis that also records every srem call, so a test can assert
    exactly which client a drain happened against (and that a client with
    nothing completed is never touched at all)."""

    def __init__(self, sets=None):
        super().__init__(sets=sets)
        self.srem_calls = []

    def srem(self, name, *values):
        self.srem_calls.append((name, values))
        super().srem(name, *values)


class _FailingStub:
    def Cleanup(self, request):
        raise RuntimeError("connection refused")


def _bare_controller(testcase, redis, replicas, machine_redis=None):
    """Build a GlobalController without running its heavy __init__.

    `machine_redis` optionally simulates the host -> RedisClient map that
    _launch_redis_containers()/EC2 bootstrap populate. Passing None (the
    default) leaves the attribute unset entirely, reproducing a controller
    that never got machine_redis set at all -- _trigger_cleanup must tolerate
    this and fall back to `redis` alone.
    """
    controller = GlobalController.__new__(GlobalController)
    controller.redis = redis
    patcher = patch(
        "canyonos_core.controller.global_controller.list_replicas",
        return_value=replicas,
    )
    patcher.start()
    testcase.addCleanup(patcher.stop)
    controller._lc_stubs = {}
    if machine_redis is not None:
        controller.machine_redis = machine_redis

    # Every completed request is delivered, except those a test lists in
    # `testcase.gone` (futures already expired), which are gone instead.
    def _deliver(clients, request_ids, project_id=None):
        gone = set(request_ids) & getattr(testcase, "gone", set())
        return set(request_ids) - gone, gone

    patcher = patch(
        "canyonos_core.controller.global_controller.otel_writer.deliver_completed_requests",
        side_effect=_deliver,
    )
    patcher.start()
    testcase.addCleanup(patcher.stop)
    return controller


class TriggerCleanupTests(unittest.TestCase):
    def test_sends_one_batched_call_per_replica_not_per_request(self):
        # A backlog of many completed requests must not multiply the number of
        # gRPC calls per replica -- one call per replica carrying the whole
        # batch, regardless of how large the backlog is.
        completed = {f"req{i}" for i in range(25)}
        expected = set(completed)  # snapshot -- _FakeRedis aliases this set, and
        # _trigger_cleanup drains "request:completed" via srem in place.
        redis = _FakeRedis(sets={"request:completed": completed})
        replicas = [{"address": f"host{i}:50051"} for i in range(3)]
        controller = _bare_controller(self, redis, replicas)

        stubs = {replica["address"]: _FakeStub() for replica in replicas}
        controller._get_lc_stub = lambda address: stubs[address]

        controller._trigger_cleanup()

        for address, stub in stubs.items():
            self.assertEqual(
                len(stub.calls), 1, f"expected exactly one Cleanup call to {address}"
            )
            self.assertEqual(set(stub.calls[0]["request_ids"]), expected)

        # Sending isn't draining: they stay queued until their futures are gone.
        self.assertEqual(redis.smembers("request:completed"), expected)

    def test_one_replica_failing_does_not_stop_the_others(self):
        # CAN-391: a failed Cleanup RPC must not drop requests -- dropping them is how
        # entries went missing and Redis grew unbounded. They stay queued and are
        # sent again next cycle, since their futures are still there.
        completed = {"reqA", "reqB"}
        expected = set(completed)  # snapshot -- see note in the test above
        redis = _FakeRedis(sets={"request:completed": completed})
        replicas = [
            {"address": "good:50051"},
            {"address": "bad:50051"},
        ]
        controller = _bare_controller(self, redis, replicas)

        good_stub = _FakeStub()
        stubs = {"good:50051": good_stub, "bad:50051": _FailingStub()}
        controller._get_lc_stub = lambda address: stubs[address]

        controller._trigger_cleanup()  # must not raise

        self.assertEqual(len(good_stub.calls), 1)
        self.assertEqual(set(good_stub.calls[0]["request_ids"]), expected)
        self.assertEqual(redis.smembers("request:completed"), expected)

    def test_a_request_every_replica_was_told_about_is_not_sent_each_cycle(self):
        redis = _FakeRedis(sets={"request:completed": {"req1"}})
        replicas = [{"address": f"host{i}:50051"} for i in range(2)]
        controller = _bare_controller(self, redis, replicas)
        stubs = {replica["address"]: _FakeStub() for replica in replicas}
        controller._get_lc_stub = lambda address: stubs[address]

        controller._trigger_cleanup()
        controller._trigger_cleanup()
        self.assertEqual([len(stub.calls) for stub in stubs.values()], [1, 1])

        # Sent again once the resend interval passes, in case a Cleanup was lost.
        for request_id in controller._cleanup_sent:
            controller._cleanup_sent[request_id] -= CLEANUP_RESEND_SECONDS
        controller._trigger_cleanup()
        self.assertEqual([len(stub.calls) for stub in stubs.values()], [2, 2])

    def test_a_request_a_replica_missed_is_sent_again_next_cycle(self):
        redis = _FakeRedis(sets={"request:completed": {"req1"}})
        replicas = [
            {"address": "good:50051"},
            {"address": "bad:50051"},
        ]
        controller = _bare_controller(self, redis, replicas)
        good = _FakeStub()
        stubs = {"good:50051": good, "bad:50051": _FailingStub()}
        controller._get_lc_stub = lambda address: stubs[address]

        controller._trigger_cleanup()
        controller._trigger_cleanup()

        self.assertEqual(len(good.calls), 2)

    def test_gone_requests_are_drained_and_not_sent_again(self):
        redis = _FakeRedis(sets={"request:completed": {"req1", "req2"}})
        controller = _bare_controller(self, redis, [{"address": "host:50051"}])
        stub = _FakeStub()
        controller._get_lc_stub = lambda address: stub
        self.gone = {"req1"}

        controller._trigger_cleanup()

        self.assertEqual(redis.smembers("request:completed"), {"req2"})
        self.assertEqual([set(call["request_ids"]) for call in stub.calls], [{"req2"}])

    def test_undelivered_requests_are_neither_sent_nor_drained(self):
        redis = _FakeRedis(sets={"request:completed": {"req1"}})
        controller = _bare_controller(self, redis, [{"address": "host:50051"}])
        stub = _FakeStub()
        controller._get_lc_stub = lambda address: stub
        patcher = patch(
            "canyonos_core.controller.global_controller.otel_writer.deliver_completed_requests",
            return_value=(set(), set()),
        )
        patcher.start()
        self.addCleanup(patcher.stop)

        controller._trigger_cleanup()

        self.assertEqual(stub.calls, [])
        self.assertEqual(redis.smembers("request:completed"), {"req1"})

    def test_gone_requests_drain_even_with_no_replica_reachable(self):
        # Draining depends only on Redis state, never on an LC answering.
        redis = _FakeRedis(sets={"request:completed": {"req1", "req2"}})
        controller = _bare_controller(self, redis, [{"address": "bad:50051"}])
        controller._get_lc_stub = lambda address: _FailingStub()
        self.gone = {"req1"}

        controller._trigger_cleanup()

        self.assertEqual(redis.smembers("request:completed"), {"req2"})

    def test_noop_when_nothing_completed(self):
        redis = _FakeRedis()
        replicas = [{"address": "host0:50051"}]
        controller = _bare_controller(self, redis, replicas)

        stub = _FakeStub()
        controller._get_lc_stub = lambda address: stub

        controller._trigger_cleanup()
        self.assertEqual(stub.calls, [])

    def test_noop_when_no_replicas_registered(self):
        # CAN-391: with nothing to broadcast to, nothing has been cleaned --
        # the batch must stay queued rather than being silently dropped.
        redis = _FakeRedis(sets={"request:completed": {"req1"}})
        controller = _bare_controller(self, redis, [])

        controller._trigger_cleanup()
        self.assertEqual(redis.smembers("request:completed"), {"req1"})


class MultiMachineTriggerCleanupTests(unittest.TestCase):
    """Bug D: _trigger_cleanup must not be blind to non-localhost machine Redis replicas.

    Each replica (local or EC2) records its own completions in its own Redis, never centrally.
    """

    def test_completed_request_only_on_non_localhost_machine_gets_cleaned(self):
        localhost_redis = _FakeRedis()
        ec2_redis = _FakeRedis(sets={"request:completed": {"reqE"}})
        machine_redis = {"localhost": localhost_redis, "10.0.0.5": ec2_redis}
        controller = _bare_controller(
            self,
            localhost_redis,
            [{"address": "wf:50051"}],
            machine_redis=machine_redis,
        )

        stub = _FakeStub()
        controller._get_lc_stub = lambda address: stub

        controller._trigger_cleanup()

        self.assertEqual(len(stub.calls), 1)
        self.assertEqual(set(stub.calls[0]["request_ids"]), {"reqE"})

        # A later cycle, once its futures are gone, drains it from that machine.
        self.gone = {"reqE"}
        controller._trigger_cleanup()
        self.assertEqual(ec2_redis.smembers("request:completed"), set())

    def test_requests_across_multiple_machines_batched_into_one_call_per_replica(self):
        localhost_redis = _FakeRedis(sets={"request:completed": {"reqA", "reqB"}})
        ec2_redis_1 = _FakeRedis(sets={"request:completed": {"reqC"}})
        ec2_redis_2 = _FakeRedis(sets={"request:completed": {"reqD", "reqE"}})
        machine_redis = {
            "localhost": localhost_redis,
            "ec2-1": ec2_redis_1,
            "ec2-2": ec2_redis_2,
        }
        replicas = [{"address": f"host{i}:50051"} for i in range(3)]
        controller = _bare_controller(
            self, localhost_redis, replicas, machine_redis=machine_redis
        )

        stubs = {replica["address"]: _FakeStub() for replica in replicas}
        controller._get_lc_stub = lambda address: stubs[address]

        controller._trigger_cleanup()

        expected = {"reqA", "reqB", "reqC", "reqD", "reqE"}
        for address, stub in stubs.items():
            self.assertEqual(
                len(stub.calls), 1, f"expected exactly one Cleanup call to {address}"
            )
            self.assertEqual(set(stub.calls[0]["request_ids"]), expected)

        self.gone = expected
        controller._trigger_cleanup()
        for redis in (localhost_redis, ec2_redis_1, ec2_redis_2):
            self.assertEqual(redis.smembers("request:completed"), set())

    def test_each_machine_drained_from_its_own_client_not_cross_contaminated(self):
        redis_with_data = _SpyRedis({"request:completed": {"reqX"}})
        redis_empty = _SpyRedis()
        machine_redis = {"a": redis_with_data, "b": redis_empty}
        controller = _bare_controller(
            self,
            redis_with_data,
            [{"address": "wf:50051"}],
            machine_redis=machine_redis,
        )

        stub = _FakeStub()
        controller._get_lc_stub = lambda address: stub
        self.gone = {"reqX"}

        controller._trigger_cleanup()

        self.assertEqual(redis_with_data.srem_calls, [("request:completed", ("reqX",))])
        self.assertEqual(redis_empty.srem_calls, [])

    def test_falls_back_to_self_redis_when_machine_redis_attribute_missing(self):
        # No machine_redis kwarg at all -- the attribute genuinely doesn't exist,
        # reproducing a controller built before _launch_redis_containers() ever
        # ran. Behavior must match the pre-Bug-D single-redis path exactly.
        completed = {"req1", "req2"}
        redis = _FakeRedis(sets={"request:completed": set(completed)})
        controller = _bare_controller(self, redis, [{"address": "host0:50051"}])
        self.assertFalse(hasattr(controller, "machine_redis"))

        stub = _FakeStub()
        controller._get_lc_stub = lambda address: stub

        controller._trigger_cleanup()
        self.assertEqual(set(stub.calls[0]["request_ids"]), completed)

        self.gone = completed
        controller._trigger_cleanup()
        self.assertEqual(redis.smembers("request:completed"), set())

    def test_falls_back_to_self_redis_when_machine_redis_is_empty_dict(self):
        # machine_redis present but empty -- the window right at the start of
        # __init__, before _launch_redis_containers() populates it.
        completed = {"req1"}
        redis = _FakeRedis(sets={"request:completed": set(completed)})
        controller = _bare_controller(
            self, redis, [{"address": "host0:50051"}], machine_redis={}
        )

        stub = _FakeStub()
        controller._get_lc_stub = lambda address: stub

        controller._trigger_cleanup()
        self.assertEqual(set(stub.calls[0]["request_ids"]), completed)

        self.gone = completed
        controller._trigger_cleanup()
        self.assertEqual(redis.smembers("request:completed"), set())


class RoutingAddressTests(unittest.TestCase):
    """CAN-391: the GC container must send Cleanup to each replica's
    container-reachable address, never its host-published address
    (e.g. localhost:8001) -- the GC can't reach that from inside Docker."""

    def test_cleanup_uses_address_not_published_address(self):
        completed = {"req1"}
        redis = _FakeRedis(sets={"request:completed": set(completed)})
        replicas = [
            {"published_address": "localhost:8001", "address": "container-abc:50051"}
        ]
        controller = _bare_controller(self, redis, replicas)

        routing_stub = _FakeStub()

        def _get_lc_stub(address):
            if address == "localhost:8001":
                raise AssertionError(
                    "Cleanup must not be sent to the host-published address; "
                    "the GC container cannot reach it."
                )
            return routing_stub

        controller._get_lc_stub = _get_lc_stub

        controller._trigger_cleanup()

        self.assertEqual(len(routing_stub.calls), 1)
        self.assertEqual(set(routing_stub.calls[0]["request_ids"]), completed)

    def test_distinct_addresses_across_multiple_replicas(self):
        completed = {"req1", "req2"}
        redis = _FakeRedis(sets={"request:completed": set(completed)})
        replicas = [
            {
                "published_address": f"localhost:800{i}",
                "address": f"container-{i}:50051",
            }
            for i in range(3)
        ]
        controller = _bare_controller(self, redis, replicas)

        stubs = {replica["address"]: _FakeStub() for replica in replicas}
        published = {replica["published_address"] for replica in replicas}

        def _get_lc_stub(address):
            self.assertNotIn(
                address, published, "must route by address, not published_address"
            )
            return stubs[address]

        controller._get_lc_stub = _get_lc_stub

        controller._trigger_cleanup()

        for address, stub in stubs.items():
            self.assertEqual(
                len(stub.calls),
                1,
                f"expected exactly one Cleanup call to {address}",
            )
            self.assertEqual(set(stub.calls[0]["request_ids"]), completed)


class StaleContainerNameTests(unittest.TestCase):
    """Agent containers belong to the reconciler; GC startup cleanup must not touch them."""

    @staticmethod
    def _controller(agents, running=False):
        """A controller whose _run_cmd records every `docker rm` it is asked for.

        `running` scripts the `docker inspect` probe to report a live container,
        without taking the recording away from `docker rm`.
        """
        controller = GlobalController.__new__(GlobalController)
        controller.config = {}
        controller._set_agent_specs(agents)
        controller.removed = []

        def run_cmd(cmd, host, user=None):
            if cmd[:2] == ["docker", "inspect"] and running:
                return subprocess.CompletedProcess(cmd, 0, "true\n", "")
            if cmd[:2] == ["docker", "rm"]:
                controller.removed.append(cmd[-1])
            return subprocess.CompletedProcess(cmd, 1, "", "")

        controller._run_cmd = run_cmd
        return controller

    def test_cleanup_removes_only_redis_and_metrics_containers(self):
        agents = [
            {"name": "IntentAgent", "provider": "local", "replicas": 2},
            {"name": "Remote", "provider": "ec2-pool", "replicas": 1},
        ]
        controller = self._controller(agents)

        controller._remove_stale_containers()

        self.assertEqual(
            set(controller.removed),
            {"canyonos-redis-localhost", "canyonos-metrics-localhost"},
        )

    def test_running_containers_are_left_alone(self):
        agents = [{"name": "IntentAgent", "provider": "local", "replicas": 1}]
        controller = self._controller(agents, running=True)

        controller._remove_stale_containers()

        self.assertEqual(controller.removed, [])


class ShutdownCleanupTests(unittest.TestCase):
    def test_supervisor_failure_keeps_redis_for_the_next_startup(self):
        controller = GlobalController.__new__(GlobalController)
        controller.running = True
        controller._stopping = False
        controller.agent_specs = []
        controller.redis = _FakeRedis()
        controller.redis_containers = {
            "localhost": "canyonos-redis-localhost",
            "10.0.0.5": "canyonos-redis-10-0-0-5",
        }
        controller.machine_redis = {
            host: object() for host in controller.redis_containers
        }
        controller._metrics_collectors = {}
        controller._remove_all_replicas = lambda: True

        class FailingSupervisor:
            def terminate_all(self):
                raise RuntimeError("terminate failed")

        controller.process_supervisor = FailingSupervisor()
        redis_actions = []

        def run_cmd(cmd, host, user=None):
            redis_actions.append((host, cmd[1]))
            return subprocess.CompletedProcess(cmd, 0, "", "")

        controller._run_cmd = run_cmd

        failures = controller.cleanup()

        self.assertTrue(any("terminate failed" in f for f in failures))
        self.assertEqual(redis_actions, [])

    def test_failed_redis_removal_stays_tracked_for_retry(self):
        controller = GlobalController.__new__(GlobalController)
        controller.agent_specs = []
        controller.redis_containers = {
            "localhost": "canyonos-redis-localhost",
            "10.0.0.5": "canyonos-redis-10-0-0-5",
        }
        controller.machine_redis = {
            host: object() for host in controller.redis_containers
        }
        controller._metrics_collectors = {}
        fail_local_remove = True

        def run_cmd(cmd, host, user=None):
            if fail_local_remove and host == "localhost" and cmd[1] == "rm":
                return subprocess.CompletedProcess(cmd, 1, "", "remove failed")
            return subprocess.CompletedProcess(cmd, 0, "", "")

        controller._run_cmd = run_cmd

        failures = controller._stop_redis_containers()

        self.assertEqual(len(failures), 1)
        self.assertEqual(
            controller.redis_containers,
            {"localhost": "canyonos-redis-localhost"},
        )
        self.assertEqual(set(controller.machine_redis), {"localhost"})

        fail_local_remove = False
        self.assertEqual(controller._stop_redis_containers(), [])
        self.assertEqual(controller.redis_containers, {})
        self.assertEqual(controller.machine_redis, {})


if __name__ == "__main__":
    unittest.main()
