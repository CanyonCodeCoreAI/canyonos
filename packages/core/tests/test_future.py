import json
import os
import sys
import unittest
import warnings
from unittest.mock import MagicMock, patch

import grpc

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
sys.path.insert(
    0,
    os.path.abspath(
        os.path.join(
            os.path.dirname(__file__), "..", "canyonos_core", "templates", "grpc_stubs"
        )
    ),
)

import canyonos_core.controller.future as future_module
import canyonos_core.controller.canyonos_context as canyonos_context
from fakes import _FakeRedis


class _Unavailable(grpc.RpcError, grpc.Call):
    def code(self):
        return grpc.StatusCode.UNAVAILABLE

    def details(self):
        return "Failed parsing HTTP/2"

    def initial_metadata(self):
        return None

    def trailing_metadata(self):
        return None

    def is_active(self):
        return False

    def time_remaining(self):
        return None

    def cancel(self):
        return False

    def add_callback(self, callback):
        return False


class FutureParentIdTests(unittest.TestCase):
    def setUp(self):
        self.fake_redis = _FakeRedis()
        self._orig_redis = future_module.Future.redis
        self._orig_stub = future_module.Future._stub
        future_module.Future.redis = self.fake_redis
        future_module.Future._stub = MagicMock()
        canyonos_context.set_current_future_id("")

    def tearDown(self):
        future_module.Future.redis = self._orig_redis
        future_module.Future._stub = self._orig_stub
        canyonos_context.set_current_future_id("")

    def test_parent_defaults_to_empty_when_no_future_executing(self):
        f = future_module.Future(
            parent="some/file.py", service="Svc", method="do_thing"
        )
        self.assertEqual(f.parent, "")
        self.assertEqual(self.fake_redis.hashes[f"future:{f.id}"]["parent"], "")

    def test_parent_is_the_currently_executing_future_id(self):
        canyonos_context.set_current_future_id("caller-future-id")

        f = future_module.Future(
            parent="ignored/file.py", service="Svc", method="do_thing"
        )

        self.assertEqual(f.parent, "caller-future-id")
        self.assertEqual(
            self.fake_redis.hashes[f"future:{f.id}"]["parent"], "caller-future-id"
        )

    def test_submission_failure_is_raised_by_value_not_constructor(self):
        future_module.Future._stub.Execute.side_effect = RuntimeError("submit failed")

        future = future_module.Future(
            parent="ignored/file.py", service="Svc", method="do_thing"
        )

        # The hash's `error` field is just the exception type name; the full
        # message lives in `logs` instead.
        with self.assertRaisesRegex(RuntimeError, "RuntimeError"):
            future.value()

        logs = json.loads(self.fake_redis.hashes[f"future:{future.id}"]["logs"])
        self.assertEqual(logs[0]["Attributes"]["exception.type"], "RuntimeError")
        self.assertEqual(logs[0]["Body"], "submit failed")

    def test_submit_request_never_raises_when_redis_fails_while_recording(self):
        """A Redis blip while recording a submission failure must not escape
        _submit_request/Future.__init__ into caller code."""
        call_count = {"n": 0}

        class _FlakyRedis(_FakeRedis):
            def hset_multiple(self, name, mapping):
                call_count["n"] += 1
                if call_count["n"] > 1:
                    raise ConnectionError("redis unreachable")
                super().hset_multiple(name, mapping)

        future_module.Future.redis = _FlakyRedis()
        future_module.Future._stub.Execute.side_effect = RuntimeError("submit failed")

        try:
            future_module.Future(
                parent="ignored/file.py", service="Svc", method="do_thing"
            )
        except Exception as e:
            self.fail(f"Future.__init__ raised unexpectedly: {e}")

    def test_unavailable_submission_is_retried(self):
        future_module.Future._stub.Execute.side_effect = [_Unavailable(), "queued"]

        with patch("canyonos_core.controller.utils.grpc_options.time.sleep") as sleep:
            future = future_module.Future(
                parent="ignored/file.py", service="Svc", method="do_thing"
            )

        self.assertEqual(future_module.Future._stub.Execute.call_count, 2)
        sleep.assert_called_once_with(0.5)
        self.assertEqual(future.response, "queued")
        self.assertNotIn("failed", self.fake_redis.hashes[f"future:{future.id}"])


class FutureForkTests(unittest.TestCase):
    def test_a_forked_child_drops_the_parents_stub_and_redis_client(self):
        original_stub = future_module.Future._stub
        original_redis = future_module.Future.redis
        future_module.Future._stub = MagicMock()
        try:
            # The child only checks one attribute and exits, so forking with threads running is safe.
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", DeprecationWarning)
                pid = os.fork()
            if pid == 0:
                fresh = (
                    future_module.Future._stub is None
                    and future_module.Future.redis is not original_redis
                )
                os._exit(0 if fresh else 1)
            _, status = os.waitpid(pid, 0)
            self.assertEqual(os.waitstatus_to_exitcode(status), 0)
            self.assertIsNotNone(future_module.Future._stub)
            self.assertIs(future_module.Future.redis, original_redis)
        finally:
            future_module.Future._stub = original_stub


if __name__ == "__main__":
    unittest.main()
