# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""The seam between deciding and running replicas: the Global Controller asks
`gc.orchestrator`."""

import unittest
from unittest.mock import MagicMock, call, patch

from canyonos_core.controller.global_controller import GlobalController
from canyonos_core.controller.orchestrator import CanyonOrchestrator


def _controller():
    controller = GlobalController.__new__(GlobalController)
    controller.running = True
    controller._stopping = False
    controller.agent_specs_by_name = {"Alpha": {"name": "Alpha", "provider": "local"}}
    controller.process_supervisor = MagicMock()
    return controller


class OrchestratorForTests(unittest.TestCase):
    def test_docker_and_ec2_replicas_are_self_managed_and_made_once(self):
        controller = _controller()
        self.assertIsInstance(controller.orchestrator, CanyonOrchestrator)
        self.assertIs(controller.orchestrator, controller.orchestrator)


class TheControllerGoesThroughItsOrchestratorTests(unittest.TestCase):
    def setUp(self):
        self.controller = _controller()
        self.manager = MagicMock()
        self.manager.stop_support_services.return_value = []
        self.controller.orchestrator = self.manager

    def test_scaling_a_known_agent(self):
        self.manager.set_replicas.return_value = 3
        self.assertEqual(self.controller._set_replicas("Alpha", 3), 3)
        self.manager.set_replicas.assert_called_once_with("Alpha", 3)

    def test_an_unknown_agent_never_reaches_the_manager(self):
        self.assertIsNone(self.controller._set_replicas("Ghost", 3))
        self.assertIsNone(self.controller._replace_replica("Ghost", 0))
        self.manager.set_replicas.assert_not_called()
        self.manager.replace_replica.assert_not_called()

    def test_replacing_a_replica(self):
        self.controller._replace_replica("Alpha", "1")
        self.manager.replace_replica.assert_called_once_with("Alpha", "1")

    def test_stop_terminates_then_stops_processes_then_tears_down(self):
        """Whatever removes the replicas must outlive `terminate`."""
        order = MagicMock()
        order.attach_mock(self.manager.remove_all_replicas, "remove_all_replicas")
        order.attach_mock(self.controller.process_supervisor.terminate_all, "stop")
        order.attach_mock(self.manager.stop_support_services, "stop_support_services")
        self.manager.remove_all_replicas.return_value = True

        self.assertEqual(self.controller.stop(), [])

        self.assertEqual(
            order.mock_calls,
            [call.remove_all_replicas(), call.stop(), call.stop_support_services(True)],
        )

    def test_a_failed_stop_is_not_a_clean_teardown(self):
        self.manager.remove_all_replicas.return_value = True
        self.controller.process_supervisor.terminate_all.side_effect = OSError("x")
        self.manager.stop_support_services.return_value = ["redis: kept"]

        failures = self.controller.stop()

        self.manager.stop_support_services.assert_called_once_with(False)
        self.assertEqual(failures, ["supervised processes: x", "redis: kept"])


class SelfManagedTests(unittest.TestCase):
    def _manager(self):
        gc = MagicMock()
        gc._stop_redis_containers.return_value = []
        return CanyonOrchestrator(gc), gc

    def test_a_clean_teardown_removes_redis_too(self):
        manager, gc = self._manager()
        with patch("canyonos_core.controller.orchestrator.state.clear_stopping"):
            failures = manager.stop_support_services(clean=True)
        gc._stop_metrics_collectors.assert_called_once()
        gc._stop_redis_containers.assert_called_once()
        self.assertEqual(failures, [])

    def test_anything_left_behind_keeps_redis_for_the_next_startup(self):
        manager, gc = self._manager()
        with patch("canyonos_core.controller.orchestrator.state.clear_stopping"):
            failures = manager.stop_support_services(clean=False)
        gc._stop_redis_containers.assert_not_called()
        self.assertEqual(failures, ["redis: kept for the next startup to reconcile"])


if __name__ == "__main__":
    unittest.main()
