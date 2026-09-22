"""GlobalController teardown: draining through the reconciler, then shutting down.

Exercises GlobalController.stop() and _drain_instances, not the reconciler itself.
"""

import os
import sys
import time
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from canyonos_core.controller.global_controller import GlobalController
from canyonos_core.reconciler import state
from fakes import _FakeRedis


def _instance(agent_name, replica_index, created_at=None, host_port=None):
    return {
        "agent_name": agent_name,
        "provider": "local",
        "runtime_id": f"canyonos-{agent_name.lower()}-{replica_index}",
        "container_port": "50051",
        "replica_index": str(replica_index),
        "host": "localhost",
        "host_port": str(host_port or 8000 + replica_index),
        "created_at": str(created_at if created_at is not None else time.time()),
    }


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
        self.list_instances = self.enterContext(
            patch("canyonos_core.controller.global_controller.list_instances")
        )
        self.list_instances.side_effect = list(instances)
        controller._stop_redis_containers = MagicMock()
        return controller

    def test_drain_returns_true_once_the_reconciler_has_removed_everything(self):
        controller = self._controller([[_instance("Alpha", 0)], []])

        with patch("time.sleep"):
            self.assertTrue(controller._drain_instances(timeout=5))

        self.assertTrue(state.is_draining(controller.redis))

    def test_drain_asks_the_reconciler_to_converge_before_waiting(self):
        controller = self._controller([[]])

        with patch("time.sleep"):
            controller._drain_instances(timeout=5)

        self.assertEqual(controller.redis.lists[state.WAKE_QUEUE_KEY], [state.WAKE_ALL])

    def test_drain_gives_up_after_the_timeout(self):
        controller = self._controller([[_instance("Alpha", 0)]] * 50)

        with patch("time.sleep"):
            with self.assertLogs(
                "canyonos_core.controller.global_controller", "WARNING"
            ):
                self.assertFalse(controller._drain_instances(timeout=0))

    def test_stop_drains_before_killing_the_reconciler(self):
        """The reconciler is what removes the instances, so it has to outlive the
        drain -- the reverse of the order the otel exporter wants."""
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
        """The controller has no container-removal verb any more. Instances left by a
        timed-out drain are the next startup's reconcile to deal with: it reaps the
        ones that are no longer healthy and reuses the ones that are."""
        controller = self._controller([[_instance("Alpha", 0)]])
        controller._drain_instances = lambda *a, **k: False

        controller.stop()

        self.assertFalse(state.is_draining(controller.redis))
        controller._stop_redis_containers.assert_called_once()

    def test_a_second_stop_is_a_noop(self):
        """cleanup() runs from a signal handler and again from atexit; a re-entrant
        stop would start a second drain mid-teardown."""
        controller = self._controller([[], []])

        with patch("time.sleep"):
            controller.stop()
            controller.stop()

        controller._stop_redis_containers.assert_called_once()


if __name__ == "__main__":
    unittest.main()
