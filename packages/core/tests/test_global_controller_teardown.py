# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""GlobalController.stop() and _remove_all_replicas, not the reconciler itself."""

import os
import sys
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from canyonos_core.controller.global_controller import GlobalController
from canyonos_core.endpoint import ADDRESS_KEY
from canyonos_core.reconciler import state
from fakes import _FakeRedis

ALPHA_KEY = "agent_instance:Alpha-0"
MACHINE_KEY = "machine_record:launch-1"


class TeardownTests(unittest.TestCase):
    def _controller(self, snapshots):
        """Return a controller whose `redis.scan_keys` reads the next snapshot of record
        keys on each pass, returning those that match the pattern."""
        controller = GlobalController.__new__(GlobalController)
        controller.running = True
        controller._stopping = False
        controller.redis = _FakeRedis()
        controller.redis_containers = {}
        controller.process_supervisor = MagicMock()
        passes = iter(snapshots)
        current = []

        def scan_keys(pattern):
            nonlocal current
            if pattern == "agent_instance:*":
                current = next(passes)
            return [key for key in current if key.startswith(pattern[:-1])]

        controller.redis.scan_keys = MagicMock(side_effect=scan_keys)
        controller._stop_redis_containers = MagicMock()
        controller._stop_metrics_collectors = MagicMock()
        return controller

    def test_remove_all_replicas_wakes_the_reconciler_and_returns_true_once_everything_is_gone(
        self,
    ):
        controller = self._controller([[ALPHA_KEY], []])

        with patch("time.sleep"):
            self.assertTrue(controller._remove_all_replicas(timeout=5))

        self.assertTrue(state.is_stopping(controller.redis))
        self.assertEqual(controller.redis.lists[state.WAKE_QUEUE_KEY], [state.WAKE_ALL])

    def test_remove_all_replicas_waits_for_the_machines_after_the_replicas(self):
        controller = self._controller([[ALPHA_KEY, MACHINE_KEY], [MACHINE_KEY], []])

        with patch("time.sleep") as sleep:
            self.assertTrue(controller._remove_all_replicas(timeout=5))

        self.assertEqual(sleep.call_count, 2)

    def test_machine_metrics_keys_do_not_hold_up_the_stop(self):
        controller = self._controller([["machine:localhost:metrics"]])

        with patch("time.sleep"):
            self.assertTrue(controller._remove_all_replicas(timeout=5))

    def test_remove_all_replicas_gives_up_after_the_timeout(self):
        controller = self._controller([[ALPHA_KEY]] * 50)
        controller.redis.hset_multiple(ADDRESS_KEY, {"public_host": "127.0.0.1"})

        with patch("time.sleep"):
            with self.assertLogs(
                "canyonos_core.controller.global_controller", "WARNING"
            ):
                self.assertFalse(controller._remove_all_replicas(timeout=0))

        self.assertEqual(
            controller.redis.hgetall(ADDRESS_KEY), {"public_host": "127.0.0.1"}
        )

    def test_stop_removes_replicas_before_killing_the_reconciler(self):
        """The reconciler removes the replicas, so it has to outlive the removal."""
        controller = self._controller([[ALPHA_KEY], []])
        calls = []
        controller.redis.scan_keys.side_effect = lambda *a, **k: (
            calls.append("list") or ([] if len(calls) > 1 else [1])
        )
        controller.process_supervisor.terminate_all.side_effect = lambda: calls.append(
            "terminate"
        )

        with patch("time.sleep"):
            controller.stop()

        self.assertEqual(calls.index("terminate"), len(calls) - 1)

    def test_stop_clears_the_flag_after_a_clean_removal(self):
        controller = self._controller([[]])

        with patch("time.sleep"):
            controller.stop()

        self.assertFalse(state.is_stopping(controller.redis))
        controller._stop_redis_containers.assert_called_once()

    def test_redis_is_the_last_thing_stopped(self):
        controller = self._controller([[]])
        calls = []
        controller.process_supervisor.terminate_all.side_effect = lambda: calls.append(
            "terminate"
        )
        controller._stop_metrics_collectors.side_effect = lambda: calls.append(
            "metrics"
        )
        controller._stop_redis_containers.side_effect = lambda: (
            calls.append("redis") or []
        )

        with patch("time.sleep"):
            controller.stop()

        self.assertEqual(calls, ["terminate", "metrics", "redis"])

    def test_a_timed_out_removal_still_finishes_shutting_down(self):
        """Replicas left by a timed-out removal are the next startup's reconcile to deal with."""
        controller = self._controller([[ALPHA_KEY]])
        controller._remove_all_replicas = lambda *a, **k: False

        controller.stop()

        self.assertFalse(state.is_stopping(controller.redis))
        controller.process_supervisor.terminate_all.assert_called_once()
        controller._stop_redis_containers.assert_not_called()

    def test_a_redis_outage_during_the_removal_still_finishes_shutting_down(self):
        controller = self._controller([])
        controller._remove_all_replicas = MagicMock(side_effect=ConnectionError("down"))
        controller.redis.delete = MagicMock(side_effect=ConnectionError("down"))
        controller._stop_redis_containers.return_value = []

        with self.assertLogs("canyonos_core.controller.global_controller", "ERROR"):
            failures = controller.stop()

        controller.process_supervisor.terminate_all.assert_called_once()
        controller._stop_redis_containers.assert_not_called()
        controller._stop_metrics_collectors.assert_called_once()
        self.assertEqual(
            [failure.split(":")[0] for failure in failures],
            ["replica removal", "stopping flag", "redis"],
        )

    def test_a_second_stop_is_a_noop(self):
        """cleanup() runs from a signal handler and again from atexit."""
        controller = self._controller([[], []])

        with patch("time.sleep"):
            controller.stop()
            controller.stop()

        controller._stop_redis_containers.assert_called_once()


if __name__ == "__main__":
    unittest.main()
