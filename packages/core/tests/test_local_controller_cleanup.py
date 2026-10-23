# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

import json
import os
import sys
import unittest

import grpc
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
sys.path.insert(
    0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "grpc_stubs"))
)

from canyonos_core.controller.local_controller_frontend import (
    EXECUTE_DEDUP_TTL_SECONDS,
    FUTURE_CLEANUP_GRACE_SECONDS,
    LocalControllerServicer,
)
from fakes import _FakeRedis
import local_controller_pb2


class ExecuteDedupTests(unittest.TestCase):
    def _servicer(self, address="10.0.0.1:50051", redis=None):
        servicer = SimpleNamespace(
            my_address=address,
            redis=redis if redis is not None else _FakeRedis(),
            request_queue=__import__("queue").Queue(),
            refusing=False,
        )
        servicer._already_accepted = lambda payload: (
            LocalControllerServicer._already_accepted(servicer, payload)
        )
        return servicer

    def _execute(self, servicer, payload):
        request = local_controller_pb2.JsonResponse(response=json.dumps(payload))
        return LocalControllerServicer.Execute(servicer, request, context=None)

    def test_a_retried_delivery_of_the_same_future_is_queued_once(self):
        servicer = self._servicer()

        first = self._execute(servicer, {"future_id": "f1", "function": "run"})
        second = self._execute(servicer, {"future_id": "f1", "function": "run"})

        self.assertEqual(servicer.request_queue.qsize(), 1)
        self.assertEqual(first.response, second.response)

    def test_the_acceptance_key_is_created_with_its_expiry(self):
        servicer = self._servicer()

        self._execute(servicer, {"future_id": "f1", "function": "run"})

        self.assertEqual(
            servicer.redis.ttls["execute:10.0.0.1:50051:f1:accepted"],
            EXECUTE_DEDUP_TTL_SECONDS,
        )

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


class _AbortContext:
    def abort(self, code, details):
        self.code = code
        raise RuntimeError(details)


class DrainRefusalTests(unittest.TestCase):
    def setUp(self):
        self.servicer = ExecuteDedupTests._servicer(self)
        self.servicer.refusing = True

    def test_a_forwarded_request_is_refused_before_it_is_queued(self):
        context = _AbortContext()
        request = local_controller_pb2.JsonResponse(
            response=json.dumps({"future_id": "f1", "route_to": "10.0.0.1:50051"})
        )

        with self.assertRaises(RuntimeError):
            LocalControllerServicer.Execute(self.servicer, request, context)

        # UNAVAILABLE is what the sender treats as "never reached, pick again".
        self.assertEqual(context.code, grpc.StatusCode.UNAVAILABLE)
        self.assertEqual(self.servicer.request_queue.qsize(), 0)
        self.assertEqual(self.servicer.redis.strings, {})

    def test_its_own_calls_are_still_queued(self):
        request = local_controller_pb2.JsonResponse(
            response=json.dumps({"future_id": "f1"})
        )

        LocalControllerServicer.Execute(self.servicer, request, context=None)

        self.assertEqual(self.servicer.request_queue.qsize(), 1)


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
        servicer = SimpleNamespace(
            _cleanup_request=lambda rid: cleaned.append(rid),
            open_requests={"req1", "req2", "other"},
        )
        request = local_controller_pb2.JsonResponse(
            response=json.dumps({"request_ids": ["req1", "req2", "req3"]})
        )

        with patch(
            "canyonos_core.controller.local_controller_frontend.Thread", _SyncThread
        ):
            LocalControllerServicer.Cleanup(servicer, request, context=None)

        self.assertEqual(cleaned, ["req1", "req2", "req3"])
        # A finished request no longer holds this replica's drain.
        self.assertEqual(servicer.open_requests, {"other"})

    def test_missing_ids_does_not_dispatch(self):
        cleaned = []
        servicer = SimpleNamespace(_cleanup_request=lambda rid: cleaned.append(rid))
        request = local_controller_pb2.JsonResponse(response=json.dumps({}))

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
        request = local_controller_pb2.JsonResponse(
            response=json.dumps({"request_id": "req-legacy"})
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

        servicer = SimpleNamespace(
            _cleanup_request=_cleanup_request, open_requests=set()
        )
        request = local_controller_pb2.JsonResponse(
            response=json.dumps({"request_ids": ["req1", "req2", "req3"]})
        )

        with patch(
            "canyonos_core.controller.local_controller_frontend.Thread", _SyncThread
        ):
            LocalControllerServicer.Cleanup(servicer, request, context=None)

        self.assertEqual(cleaned, ["req1", "req3"])


def _bare_servicer(redis):
    servicer = LocalControllerServicer.__new__(LocalControllerServicer)
    servicer.redis = redis
    servicer.my_address = "test-node"
    return servicer


class CleanupRequestTests(unittest.TestCase):
    def test_cleanup_expires_consolidated_future_hashes_and_bookkeeping(self):
        # CAN-391 follow-up: GlobalController's poll loop reads future:{id} to build an
        # OTel span, so deleting it here races that read. Expiring with a grace period
        # keeps memory bounded without dropping the span.
        redis = _FakeRedis(
            sets={"request:req1:futures": {"fut1", "fut2"}},
            strings={
                "telemetry:delivered:req1": "1",
                "future:fut1": "x",
                "future:fut2": "x",
                "future:fut1:children": "x",
                "future:fut1:consumers": "x",
                "request:req1:future": "fut1",
                "request:req1:context": "x",
            },
        )
        servicer = _bare_servicer(redis)

        servicer._cleanup_request("req1")

        # Not deleted outright -- still readable until the TTL elapses.
        for key in (
            "request:req1:futures",
            "request:req1:future",
            "request:req1:context",
            "future:fut1",
            "future:fut2",
            "future:fut1:children",
            "future:fut1:consumers",
            "telemetry:delivered:req1",
        ):
            self.assertEqual(redis.ttls.get(key), FUTURE_CLEANUP_GRACE_SECONDS)
        self.assertIn("request:req1:futures", redis.sets)
        self.assertIn("future:fut1", redis.strings)
        # Expired last, so it can't lapse before the futures and be re-marked.
        self.assertEqual(list(redis.ttls)[-1], "telemetry:delivered:req1")

    def test_cleanup_still_deletes_affinity_bindings_outright(self):
        # Affinity bindings aren't read by the telemetry poll loop, so there's
        # no race to protect against here -- immediate deletion is still fine.
        redis = _FakeRedis(
            sets={"request:req1:futures": {"fut1"}},
            strings={
                "telemetry:delivered:req1": "1",
                "future:fut1": "x",
                "affinity:req1": "some-host",
            },
        )
        servicer = _bare_servicer(redis)

        servicer._cleanup_request("req1")

        self.assertNotIn("affinity:req1", redis.strings)
        # The future itself is expired (grace period), not deleted outright.
        self.assertIn("future:fut1", redis.strings)
        self.assertEqual(redis.ttls.get("future:fut1"), FUTURE_CLEANUP_GRACE_SECONDS)

    def test_cleanup_releases_its_lock_even_with_no_futures(self):
        redis = _FakeRedis(
            strings={"telemetry:delivered:req1": "1"},
            sets={"request:req1:futures": set()},
        )
        servicer = _bare_servicer(redis)

        servicer._cleanup_request("req1")

        self.assertNotIn("request:req1:cleanup_lock", redis.strings)
        # A machine holding none of the request's futures still expires its marker.
        self.assertEqual(
            redis.ttls.get("telemetry:delivered:req1"), FUTURE_CLEANUP_GRACE_SECONDS
        )

    def test_cleanup_waits_for_telemetry_delivery(self):
        redis = _FakeRedis(
            sets={"request:req1:futures": {"fut1"}}, strings={"future:fut1": "x"}
        )
        servicer = _bare_servicer(redis)

        servicer._cleanup_request("req1")

        self.assertNotIn("request:req1:cleanup_lock", redis.strings)
        self.assertEqual(redis.ttls, {})


if __name__ == "__main__":
    unittest.main()
