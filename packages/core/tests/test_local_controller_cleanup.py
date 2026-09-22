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
import local_controler_pb2


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


class _FakeRedisStore:
    """Enough of RedisClient's surface for _cleanup_request: strings, sets, setnx."""

    def __init__(self, strings=None, sets=None):
        self.strings = strings or {}
        self.sets = sets or {}
        self.expirations = {}  # key -> seconds, as recorded by expire()

    def setnx(self, key, value):
        if key in self.strings:
            return False
        self.strings[key] = value
        return True

    def smembers(self, name):
        return set(self.sets.get(name, set()))

    def delete(self, *keys):
        for key in keys:
            self.strings.pop(key, None)
            self.sets.pop(key, None)

    def expire(self, key, seconds):
        # Real Redis: schedules removal after `seconds`, doesn't touch the
        # value now. This fake just records the call so tests can assert on
        # it without needing to fake time passing.
        self.expirations[key] = seconds


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
        redis = _FakeRedisStore(
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
            self.assertEqual(redis.expirations.get(key), FUTURE_CLEANUP_GRACE_SECONDS)
        self.assertIn("request:req1:futures", redis.sets)
        self.assertIn("future:fut1", redis.strings)

    def test_cleanup_still_deletes_affinity_bindings_outright(self):
        # Affinity bindings aren't read by the telemetry poll loop, so there's
        # no race to protect against here -- immediate deletion is still fine.
        redis = _FakeRedisStore(
            sets={"request:req1:futures": {"fut1"}},
            strings={"future:fut1": "x", "affinity:req1": "some-host"},
        )
        servicer = _bare_servicer(redis)

        servicer._cleanup_request("req1")

        self.assertNotIn("affinity:req1", redis.strings)
        # The future itself is expired (grace period), not deleted outright.
        self.assertIn("future:fut1", redis.strings)
        self.assertEqual(
            redis.expirations.get("future:fut1"), FUTURE_CLEANUP_GRACE_SECONDS
        )

    def test_cleanup_releases_its_lock_even_with_no_futures(self):
        redis = _FakeRedisStore(sets={"request:req1:futures": set()})
        servicer = _bare_servicer(redis)

        servicer._cleanup_request("req1")

        self.assertNotIn("request:req1:cleanup_lock", redis.strings)


if __name__ == "__main__":
    unittest.main()
