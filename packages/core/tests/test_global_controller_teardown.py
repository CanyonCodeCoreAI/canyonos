"""GlobalController.stop() and _drain_instances, not the reconciler itself."""

import os
import sys
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from canyonos_core.controller.global_controller import GlobalController
from canyonos_core.reconciler import state
from fakes import _FakeRedis, _instance


class TeardownTests(unittest.TestCase):
    def _controller(self, instances):
        """A controller whose list_instances() walks the given snapshots, one per call."""
        controller = GlobalController.__new__(GlobalController)
        controller.running = True
        controller._stopping = False
        controller.redis = _FakeRedis()
        controller.redis_containers = {}
        controller.containers = {}
        controller.process_supervisor = MagicMock()
        patcher = patch("canyonos_core.controller.global_controller.list_instances")
        self.list_instances = patcher.start()
        self.addCleanup(patcher.stop)
        self.list_instances.side_effect = list(instances)
        controller._stop_redis_containers = MagicMock()
        controller._stop_metrics_collectors = MagicMock()
        return controller

    def test_drain_wakes_the_reconciler_and_returns_true_once_everything_is_gone(self):
        controller = self._controller([[_instance("Alpha", 0)], []])

        with patch("time.sleep"):
            self.assertTrue(controller._drain_instances(timeout=5))

        self.assertTrue(state.is_draining(controller.redis))
        self.assertEqual(controller.redis.lists[state.WAKE_QUEUE_KEY], [state.WAKE_ALL])

    def test_drain_gives_up_after_the_timeout(self):
        controller = self._controller([[_instance("Alpha", 0)]] * 50)

        with patch("time.sleep"):
            with self.assertLogs(
                "canyonos_core.controller.global_controller", "WARNING"
            ):
                self.assertFalse(controller._drain_instances(timeout=0))

    def test_stop_drains_before_killing_the_reconciler(self):
        """The reconciler removes the instances, so it has to outlive the drain."""
        controller = self._controller([[_instance("Alpha", 0)], []])
        calls = []
        self.list_instances.side_effect = lambda *a, **k: (
            calls.append("list") or ([] if len(calls) > 1 else [1])
        )
        controller.process_supervisor.terminate_all.side_effect = lambda: calls.append(
            "terminate"
        )

        with patch("time.sleep"):
            controller.stop()

        self.assertEqual(calls.index("terminate"), len(calls) - 1)

    def test_stop_clears_the_flag_after_a_clean_drain(self):
        controller = self._controller([[]])

        with patch("time.sleep"):
            controller.stop()

        self.assertFalse(state.is_draining(controller.redis))
        controller._stop_redis_containers.assert_called_once()

    def test_a_timed_out_drain_still_finishes_shutting_down(self):
        """Instances left by a timed-out drain are the next startup's reconcile to deal with."""
        controller = self._controller([[_instance("Alpha", 0)]])
        controller._drain_instances = lambda *a, **k: False

        controller.stop()

        self.assertFalse(state.is_draining(controller.redis))
        controller._stop_redis_containers.assert_called_once()

    def test_a_redis_outage_during_the_drain_still_finishes_shutting_down(self):
        controller = self._controller([])
        controller._drain_instances = MagicMock(side_effect=ConnectionError("down"))
        controller.redis.delete = MagicMock(side_effect=ConnectionError("down"))
        controller._stop_redis_containers.return_value = []

        with self.assertLogs("canyonos_core.controller.global_controller", "ERROR"):
            failures = controller.stop()

        controller.process_supervisor.terminate_all.assert_called_once()
        controller._stop_redis_containers.assert_called_once()
        controller._stop_metrics_collectors.assert_called_once()
        self.assertEqual(
            [failure.split(":")[0] for failure in failures],
            ["instance drain", "draining flag"],
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
