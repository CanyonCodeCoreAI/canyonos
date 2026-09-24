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

from canyonos_core.controller.global_controller import GlobalController
from fakes import _FakeRedis
import local_controler_pb2


class _FakeStub:
    def __init__(self):
        self.calls = []

    def Cleanup(self, request):
        self.calls.append(json.loads(request.resonse))
        return local_controler_pb2.JsonResponse(resonse="Cleanup triggered")


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


def _bare_controller(testcase, redis, instances, node_redis=None):
    """Build a GlobalController without running its heavy __init__.

    `node_redis` optionally simulates the host -> RedisClient map that
    _launch_redis_containers()/EC2 bootstrap populate. Passing None (the
    default) leaves the attribute unset entirely, reproducing a controller
    that never got node_redis set at all -- _trigger_cleanup must tolerate
    this and fall back to `redis` alone.
    """
    controller = GlobalController.__new__(GlobalController)
    controller.redis = redis
    patcher = patch(
        "canyonos_core.controller.global_controller.list_instances",
        return_value=instances,
    )
    patcher.start()
    testcase.addCleanup(patcher.stop)
    # Fixtures use "endpoint" as the already-resolved container address unless a
    # test needs the two to differ, in which case it sets "routing_endpoint".
    patcher = patch(
        "canyonos_core.controller.global_controller.routing_endpoint_for",
        side_effect=lambda instance: instance.get(
            "routing_endpoint", instance["endpoint"]
        ),
    )
    patcher.start()
    testcase.addCleanup(patcher.stop)
    controller._lc_stubs = {}
    if node_redis is not None:
        controller.node_redis = node_redis
    return controller


class TriggerCleanupTests(unittest.TestCase):
    def test_sends_one_batched_call_per_instance_not_per_request(self):
        # A backlog of many completed requests must not multiply the number of
        # gRPC calls per instance -- one call per instance carrying the whole
        # batch, regardless of how large the backlog is.
        completed = {f"req{i}" for i in range(25)}
        expected = set(completed)  # snapshot -- _FakeRedis aliases this set, and
        # _trigger_cleanup drains "request:completed" via srem in place.
        redis = _FakeRedis(sets={"request:completed": completed})
        instances = [{"endpoint": f"host{i}:50051"} for i in range(3)]
        controller = _bare_controller(self, redis, instances)

        stubs = {instance["endpoint"]: _FakeStub() for instance in instances}
        controller._get_lc_stub = lambda endpoint: stubs[endpoint]

        controller._trigger_cleanup()

        for endpoint, stub in stubs.items():
            self.assertEqual(
                len(stub.calls), 1, f"expected exactly one Cleanup call to {endpoint}"
            )
            self.assertEqual(set(stub.calls[0]["request_ids"]), expected)

        # Drained after broadcasting, same as before.
        self.assertEqual(redis.smembers("request:completed"), set())

    def test_one_instance_failing_leaves_the_batch_queued_for_retry(self):
        # CAN-391: a batch is only ever removed from "request:completed" once
        # every instance has confirmed receipt. If even one Cleanup RPC fails
        # (e.g. an unreachable endpoint), the whole batch must stay queued --
        # dropping it here is how cleanup entries went missing and Redis grew
        # unbounded.
        completed = {"reqA", "reqB"}
        expected = set(completed)  # snapshot -- see note in the test above
        redis = _FakeRedis(sets={"request:completed": completed})
        instances = [{"endpoint": "good:50051"}, {"endpoint": "bad:50051"}]
        controller = _bare_controller(self, redis, instances)

        good_stub = _FakeStub()
        stubs = {"good:50051": good_stub, "bad:50051": _FailingStub()}
        controller._get_lc_stub = lambda endpoint: stubs[endpoint]

        controller._trigger_cleanup()  # must not raise

        # The reachable instance still gets the batch...
        self.assertEqual(len(good_stub.calls), 1)
        self.assertEqual(set(good_stub.calls[0]["request_ids"]), expected)
        # ...but nothing is drained until every instance has confirmed.
        self.assertEqual(redis.smembers("request:completed"), expected)

    def test_noop_when_nothing_completed(self):
        redis = _FakeRedis()
        instances = [{"endpoint": "host0:50051"}]
        controller = _bare_controller(self, redis, instances)

        stub = _FakeStub()
        controller._get_lc_stub = lambda endpoint: stub

        controller._trigger_cleanup()
        self.assertEqual(stub.calls, [])

    def test_noop_when_no_instances_registered(self):
        # CAN-391: with nothing to broadcast to, nothing has confirmed the
        # batch -- it must stay queued rather than being silently dropped.
        redis = _FakeRedis(sets={"request:completed": {"req1"}})
        controller = _bare_controller(self, redis, [])

        controller._trigger_cleanup()
        self.assertEqual(redis.smembers("request:completed"), {"req1"})


class MultiNodeTriggerCleanupTests(unittest.TestCase):
    """Bug D: _trigger_cleanup must not be blind to non-localhost node Redis instances.

    Each replica (local or EC2) records its own completions in its own Redis, never centrally.
    """

    def test_completed_request_only_on_non_localhost_node_gets_cleaned(self):
        localhost_redis = _FakeRedis()
        ec2_redis = _FakeRedis(sets={"request:completed": {"reqE"}})
        node_redis = {"localhost": localhost_redis, "10.0.0.5": ec2_redis}
        controller = _bare_controller(
            self, localhost_redis, [{"endpoint": "wf:50051"}], node_redis=node_redis
        )

        stub = _FakeStub()
        controller._get_lc_stub = lambda endpoint: stub

        controller._trigger_cleanup()

        self.assertEqual(len(stub.calls), 1)
        self.assertEqual(set(stub.calls[0]["request_ids"]), {"reqE"})
        self.assertEqual(ec2_redis.smembers("request:completed"), set())

    def test_requests_across_multiple_nodes_batched_into_one_call_per_instance(self):
        localhost_redis = _FakeRedis(sets={"request:completed": {"reqA", "reqB"}})
        ec2_redis_1 = _FakeRedis(sets={"request:completed": {"reqC"}})
        ec2_redis_2 = _FakeRedis(sets={"request:completed": {"reqD", "reqE"}})
        node_redis = {
            "localhost": localhost_redis,
            "ec2-1": ec2_redis_1,
            "ec2-2": ec2_redis_2,
        }
        instances = [{"endpoint": f"host{i}:50051"} for i in range(3)]
        controller = _bare_controller(
            self, localhost_redis, instances, node_redis=node_redis
        )

        stubs = {instance["endpoint"]: _FakeStub() for instance in instances}
        controller._get_lc_stub = lambda endpoint: stubs[endpoint]

        controller._trigger_cleanup()

        expected = {"reqA", "reqB", "reqC", "reqD", "reqE"}
        for endpoint, stub in stubs.items():
            self.assertEqual(
                len(stub.calls), 1, f"expected exactly one Cleanup call to {endpoint}"
            )
            self.assertEqual(set(stub.calls[0]["request_ids"]), expected)

        for redis in (localhost_redis, ec2_redis_1, ec2_redis_2):
            self.assertEqual(redis.smembers("request:completed"), set())

    def test_each_node_drained_from_its_own_client_not_cross_contaminated(self):
        redis_with_data = _SpyRedis({"request:completed": {"reqX"}})
        redis_empty = _SpyRedis()
        node_redis = {"a": redis_with_data, "b": redis_empty}
        controller = _bare_controller(
            self, redis_with_data, [{"endpoint": "wf:50051"}], node_redis=node_redis
        )

        stub = _FakeStub()
        controller._get_lc_stub = lambda endpoint: stub

        controller._trigger_cleanup()

        self.assertEqual(redis_with_data.srem_calls, [("request:completed", ("reqX",))])
        self.assertEqual(redis_empty.srem_calls, [])

    def test_falls_back_to_self_redis_when_node_redis_attribute_missing(self):
        # No node_redis kwarg at all -- the attribute genuinely doesn't exist,
        # reproducing a controller built before _launch_redis_containers() ever
        # ran. Behavior must match the pre-Bug-D single-redis path exactly.
        completed = {"req1", "req2"}
        redis = _FakeRedis(sets={"request:completed": set(completed)})
        controller = _bare_controller(self, redis, [{"endpoint": "host0:50051"}])
        self.assertFalse(hasattr(controller, "node_redis"))

        stub = _FakeStub()
        controller._get_lc_stub = lambda endpoint: stub

        controller._trigger_cleanup()

        self.assertEqual(set(stub.calls[0]["request_ids"]), completed)
        self.assertEqual(redis.smembers("request:completed"), set())

    def test_falls_back_to_self_redis_when_node_redis_is_empty_dict(self):
        # node_redis present but empty -- the window right at the start of
        # __init__, before _launch_redis_containers() populates it.
        completed = {"req1"}
        redis = _FakeRedis(sets={"request:completed": set(completed)})
        controller = _bare_controller(
            self, redis, [{"endpoint": "host0:50051"}], node_redis={}
        )

        stub = _FakeStub()
        controller._get_lc_stub = lambda endpoint: stub

        controller._trigger_cleanup()

        self.assertEqual(set(stub.calls[0]["request_ids"]), completed)
        self.assertEqual(redis.smembers("request:completed"), set())


class RoutingEndpointTests(unittest.TestCase):
    """CAN-391: the GC container must send Cleanup to each instance's
    container-reachable routing endpoint, never its host-published endpoint
    (e.g. localhost:8001) -- the GC can't reach that from inside Docker.
    Every other test in this file gives an instance the same value for both,
    so a regression back to instance["endpoint"] would pass them unnoticed."""

    def test_cleanup_uses_routing_endpoint_not_published_endpoint(self):
        completed = {"req1"}
        redis = _FakeRedis(sets={"request:completed": set(completed)})
        instances = [
            {"endpoint": "localhost:8001", "routing_endpoint": "runtime-abc:50051"}
        ]
        controller = _bare_controller(self, redis, instances)

        routing_stub = _FakeStub()

        def _get_lc_stub(endpoint):
            if endpoint == "localhost:8001":
                raise AssertionError(
                    "Cleanup must not be sent to the host-published endpoint; "
                    "the GC container cannot reach it."
                )
            return routing_stub

        controller._get_lc_stub = _get_lc_stub

        controller._trigger_cleanup()

        self.assertEqual(len(routing_stub.calls), 1)
        self.assertEqual(set(routing_stub.calls[0]["request_ids"]), completed)
        self.assertEqual(redis.smembers("request:completed"), set())

    def test_distinct_endpoints_across_multiple_instances(self):
        completed = {"req1", "req2"}
        redis = _FakeRedis(sets={"request:completed": set(completed)})
        instances = [
            {"endpoint": f"localhost:800{i}", "routing_endpoint": f"runtime-{i}:50051"}
            for i in range(3)
        ]
        controller = _bare_controller(self, redis, instances)

        stubs = {inst["routing_endpoint"]: _FakeStub() for inst in instances}
        published = {inst["endpoint"] for inst in instances}

        def _get_lc_stub(endpoint):
            self.assertNotIn(
                endpoint, published, "must route by routing_endpoint, not endpoint"
            )
            return stubs[endpoint]

        controller._get_lc_stub = _get_lc_stub

        controller._trigger_cleanup()

        for routing_endpoint, stub in stubs.items():
            self.assertEqual(
                len(stub.calls),
                1,
                f"expected exactly one Cleanup call to {routing_endpoint}",
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
        controller.controllers = agents
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
            {"name": "IntentAgent", "replicas": 2},
            {"name": "Remote", "provider": "EC2", "replicas": 1},
        ]
        controller = self._controller(agents)

        controller._cleanup_stale_containers()

        self.assertEqual(
            set(controller.removed),
            {"canyonos-redis-localhost", "canyonos-metrics-localhost"},
        )

    def test_running_containers_are_left_alone(self):
        agents = [{"name": "IntentAgent", "replicas": 1}]
        controller = self._controller(agents, running=True)

        controller._cleanup_stale_containers()

        self.assertEqual(controller.removed, [])


class ShutdownCleanupTests(unittest.TestCase):
    def test_supervisor_failure_keeps_redis_for_the_next_startup(self):
        controller = GlobalController.__new__(GlobalController)
        controller.running = True
        controller._stopping = False
        controller.controllers = []
        controller.redis = _FakeRedis()
        controller.redis_containers = {
            "localhost": "canyonos-redis-localhost",
            "10.0.0.5": "canyonos-redis-10-0-0-5",
        }
        controller.node_redis = {host: object() for host in controller.redis_containers}
        controller._metrics_collectors = {}
        controller._drain_instances = lambda: True

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
        controller.controllers = []
        controller.redis_containers = {
            "localhost": "canyonos-redis-localhost",
            "10.0.0.5": "canyonos-redis-10-0-0-5",
        }
        controller.node_redis = {host: object() for host in controller.redis_containers}
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
        self.assertEqual(set(controller.node_redis), {"localhost"})

        fail_local_remove = False
        self.assertEqual(controller._stop_redis_containers(), [])
        self.assertEqual(controller.redis_containers, {})
        self.assertEqual(controller.node_redis, {})


if __name__ == "__main__":
    unittest.main()
