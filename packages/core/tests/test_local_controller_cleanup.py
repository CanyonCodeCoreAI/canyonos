import json
import os
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
sys.path.insert(
    0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "grpc_stubs"))
)

from canyonos_core.controller.local_controller_frontend import (
    FUTURE_CLEANUP_GRACE_SECONDS,
    LocalControllerServicer,
)
from fakes import _FakeRedis
import local_controler_pb2


class ExecuteDedupTests(unittest.TestCase):
    def _servicer(self, endpoint="10.0.0.1:50051", redis=None):
        servicer = SimpleNamespace(
            my_endpoint=endpoint,
            redis=redis if redis is not None else _FakeRedis(),
            request_queue=__import__("queue").Queue(),
        )
        servicer._already_accepted = lambda payload: (
            LocalControllerServicer._already_accepted(servicer, payload)
        )
        return servicer

    def _execute(self, servicer, payload):
        request = local_controler_pb2.JsonResponse(resonse=json.dumps(payload))
        return LocalControllerServicer.Execute(servicer, request, context=None)

    def test_a_retried_delivery_of_the_same_future_is_queued_once(self):
        servicer = self._servicer()

        first = self._execute(servicer, {"future_id": "f1", "function": "run"})
        second = self._execute(servicer, {"future_id": "f1", "function": "run"})

        self.assertEqual(servicer.request_queue.qsize(), 1)
        self.assertEqual(first.resonse, second.resonse)

    def test_the_same_future_is_accepted_by_each_endpoint_sharing_a_redis(self):
        redis = _FakeRedis()
        origin = self._servicer("10.0.0.1:50051", redis)
        target = self._servicer("10.0.0.1:50052", redis)

        self._execute(origin, {"future_id": "f1"})
        self._execute(target, {"future_id": "f1"})

        self.assertEqual(origin.request_queue.qsize(), 1)
        self.assertEqual(target.request_queue.qsize(), 1)

    def test_payloads_without_a_future_id_are_always_queued(self):
        servicer = self._servicer()

        self._execute(servicer, {"function": "run"})
        self._execute(servicer, {"function": "run"})

        self.assertEqual(servicer.request_queue.qsize(), 2)


class _SyncThread:
    """Stand-in for threading.Thread that runs its target immediately, inline.

    Cleanup() fires off a daemon Thread and returns without waiting for it, which
    makes the real dispatch nondeterministic to assert on in a test. Swapping this
    in for the module's Thread makes the dispatch happen synchronously instead.
    """

    def __init__(self, target=None, args=(), daemon=None):
        self._target = target
        self._args = args

    def start(self):
        self._target(*self._args)


class CleanupDispatchTests(unittest.TestCase):
    def test_batched_request_ids_dispatches_cleanup_for_each(self):
        cleaned = []
        servicer = SimpleNamespace(_cleanup_request=lambda rid: cleaned.append(rid))
        request = local_controler_pb2.JsonResponse(
            resonse=json.dumps({"request_ids": ["req1", "req2", "req3"]})
        )

        with patch(
            "canyonos_core.controller.local_controller_frontend.Thread", _SyncThread
        ):
            LocalControllerServicer.Cleanup(servicer, request, context=None)

        self.assertEqual(cleaned, ["req1", "req2", "req3"])

    def test_missing_ids_does_not_dispatch(self):
        cleaned = []
        servicer = SimpleNamespace(_cleanup_request=lambda rid: cleaned.append(rid))
        request = local_controler_pb2.JsonResponse(resonse=json.dumps({}))

        with patch(
            "canyonos_core.controller.local_controller_frontend.Thread", _SyncThread
        ):
            LocalControllerServicer.Cleanup(servicer, request, context=None)

        self.assertEqual(cleaned, [])

    def test_old_single_request_id_payload_is_no_longer_supported(self):
        # The only real caller (GlobalController._trigger_cleanup) always sends
        # request_ids now, so the pre-batching {"request_id": ...} shape is
        # intentionally treated the same as a missing/empty payload, not dispatched.
        cleaned = []
        servicer = SimpleNamespace(_cleanup_request=lambda rid: cleaned.append(rid))
        request = local_controler_pb2.JsonResponse(
            resonse=json.dumps({"request_id": "req-legacy"})
        )

        with patch(
            "canyonos_core.controller.local_controller_frontend.Thread", _SyncThread
        ):
            LocalControllerServicer.Cleanup(servicer, request, context=None)

        self.assertEqual(cleaned, [])

    def test_one_failing_request_id_does_not_stop_the_rest_of_the_batch(self):
        cleaned = []

        def _cleanup_request(rid):
            if rid == "req2":
                raise ConnectionError("redis unreachable")
            cleaned.append(rid)

        servicer = SimpleNamespace(_cleanup_request=_cleanup_request)
        request = local_controler_pb2.JsonResponse(
            resonse=json.dumps({"request_ids": ["req1", "req2", "req3"]})
        )

        with patch(
            "canyonos_core.controller.local_controller_frontend.Thread", _SyncThread
        ):
            LocalControllerServicer.Cleanup(servicer, request, context=None)

        self.assertEqual(cleaned, ["req1", "req3"])


def _bare_servicer(redis):
    servicer = LocalControllerServicer.__new__(LocalControllerServicer)
    servicer.redis = redis
    servicer.my_endpoint = "test-node"
    return servicer


class CleanupRequestTests(unittest.TestCase):
    def test_cleanup_expires_consolidated_future_hashes_and_bookkeeping(self):
        # CAN-391 follow-up: GlobalController's poll loop reads future:{id} to
        # build an OTel span (see telemetry_logging.pull_runtime_information).
        # Deleting it immediately here races that read and silently drops the
        # span. Expiring with a grace period keeps memory bounded without
        # deleting out from under the poll loop.
        redis = _FakeRedis(
            sets={"request:req1:futures": {"fut1", "fut2"}},
            strings={
                "future:fut1": "x",
                "future:fut2": "x",
                "future:fut1:children": "x",
                "future:fut1:consumers": "x",
            },
        )
        servicer = _bare_servicer(redis)

        servicer._cleanup_request("req1")

        # Not deleted outright -- still readable until the TTL elapses.
        for key in (
            "request:req1:futures",
            "future:fut1",
            "future:fut2",
            "future:fut1:children",
            "future:fut1:consumers",
        ):
            self.assertEqual(redis.ttls.get(key), FUTURE_CLEANUP_GRACE_SECONDS)
        self.assertIn("request:req1:futures", redis.sets)
        self.assertIn("future:fut1", redis.strings)

    def test_cleanup_still_deletes_affinity_bindings_outright(self):
        # Affinity bindings aren't read by the telemetry poll loop, so there's
        # no race to protect against here -- immediate deletion is still fine.
        redis = _FakeRedis(
            sets={"request:req1:futures": {"fut1"}},
            strings={"future:fut1": "x", "affinity:req1": "some-host"},
        )
        servicer = _bare_servicer(redis)

        servicer._cleanup_request("req1")

        self.assertNotIn("affinity:req1", redis.strings)
        # The future itself is expired (grace period), not deleted outright.
        self.assertIn("future:fut1", redis.strings)
        self.assertEqual(redis.ttls.get("future:fut1"), FUTURE_CLEANUP_GRACE_SECONDS)

    def test_cleanup_releases_its_lock_even_with_no_futures(self):
        redis = _FakeRedis(sets={"request:req1:futures": set()})
        servicer = _bare_servicer(redis)

        servicer._cleanup_request("req1")

        self.assertNotIn("request:req1:cleanup_lock", redis.strings)


if __name__ == "__main__":
    unittest.main()
