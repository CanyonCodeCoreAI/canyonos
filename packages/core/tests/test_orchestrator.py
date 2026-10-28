# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""The seam between deciding and running replicas: the Global Controller asks
`gc.orchestrator`."""

import os
import unittest
from unittest.mock import MagicMock, call, patch

from canyonos_core.controller.global_controller import GlobalController
from canyonos_core.controller.orchestrator import (
    TARGET_ENV,
    CanyonOrchestrator,
    orchestrator_for,
)
from canyonos_core.kubernetes.api import KubernetesError
from canyonos_core.kubernetes.orchestrator import KubernetesOrchestrator


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

    def test_kubernetes_means_operator_managed(self):
        with (
            patch.dict(os.environ, {TARGET_ENV: "kubernetes"}),
            patch(
                "canyonos_core.kubernetes.orchestrator.KubernetesApi.from_environment"
            ),
        ):
            self.assertIsInstance(
                orchestrator_for(_controller()), KubernetesOrchestrator
            )


class OperatorManagedTests(unittest.TestCase):
    def setUp(self):
        self.gc = _controller()
        self.api = MagicMock()
        self.manager = KubernetesOrchestrator(self.gc, api=self.api)

    def test_it_uses_the_project_redis_the_operator_names(self):
        with patch.dict(
            os.environ,
            {"CANYONOS_REDIS_HOST": "canyonos-redis", "CANYONOS_REDIS_PORT": "6380"},
        ):
            self.manager.start_support_services()
        kwargs = self.gc.redis.client.connection_pool.connection_kwargs
        self.assertEqual((kwargs["host"], kwargs["port"]), ("canyonos-redis", 6380))
        self.assertEqual(self.gc._redis_addr, ("canyonos-redis", 6380))
        self.assertIs(
            self.manager.machine_redis_for_replica({"private_host": "pod-0"}),
            self.gc.redis,
        )

    def test_without_a_named_redis_it_refuses_to_start(self):
        with patch.dict(os.environ):
            os.environ.pop("CANYONOS_REDIS_HOST", None)
            with self.assertRaisesRegex(RuntimeError, "CANYONOS_REDIS_HOST"):
                self.manager.start_support_services()

    def test_scaling_patches_the_canyonagent(self):
        self.assertEqual(self.manager.set_replicas("Alpha", 3), 3)
        self.api.scale_canyon_agent.assert_called_once_with("Alpha", 3)
        self.assertEqual(self.manager.set_replicas("Alpha", -2), 0)

    def test_configured_counts_are_left_to_the_canyonagents(self):
        self.manager.apply_configured_replicas({"Alpha": 2})
        self.api.scale_canyon_agent.assert_not_called()

    def test_it_starts_runs_and_removes_nothing(self):
        supervisor = MagicMock()
        self.manager.remove_stale_containers()
        self.manager.register_background_processes(supervisor)
        self.assertIsNone(self.manager.replace_replica("Alpha", "Alpha-0"))
        self.manager.forget_removed_agents({"Gone"})
        self.assertTrue(self.manager.remove_all_replicas())
        self.assertEqual(self.manager.stop_support_services(clean=True), [])
        supervisor.register.assert_not_called()
        self.api.assert_not_called()
        self.assertEqual(self.api.method_calls, [])


class OperatorManagedMachineMetricsTests(unittest.TestCase):
    def setUp(self):
        self.gc = _controller()
        self.gc.config = {"project_id": "p1"}
        self.api = MagicMock()
        self.manager = KubernetesOrchestrator(self.gc, api=self.api)

    @patch("canyonos_core.kubernetes.orchestrator.otel_writer.metric_write_rows")
    def test_pod_usage_is_recorded(self, write_rows):
        self.api.project_pods.return_value = [
            {
                "metadata": {"name": "a-0"},
                "spec": {"containers": [{"resources": {"limits": {"cpu": "1"}}}]},
            }
        ]
        self.api.pod_metrics.return_value = [
            {
                "metadata": {"name": "a-0"},
                "containers": [{"usage": {"cpu": "500m", "memory": "1Mi"}}],
            }
        ]
        self.manager.poll_machine_metrics()
        (rows,), _ = write_rows.call_args
        self.assertEqual([(r["host"], r["project_id"]) for r in rows], [("a-0", "p1")])

    @patch("canyonos_core.kubernetes.orchestrator.otel_writer.metric_write_rows")
    def test_no_metrics_api_warns_once_until_it_answers_again(self, write_rows):
        self.api.pod_metrics.side_effect = KubernetesError("404 metrics.k8s.io")
        with self.assertLogs(
            "canyonos_core.kubernetes.orchestrator", "WARNING"
        ) as logs:
            self.manager.poll_machine_metrics()
            self.manager.poll_machine_metrics()
        self.assertEqual(len(logs.output), 1)
        write_rows.assert_not_called()

        self.api.pod_metrics.side_effect = None
        self.api.pod_metrics.return_value = []
        self.manager.poll_machine_metrics()
        self.assertFalse(self.manager._metrics_unavailable)


class ConfiguredReplicasTests(unittest.TestCase):
    def test_the_controller_hands_valid_counts_to_its_manager(self):
        controller = _controller()
        controller.agent_specs = [
            {"name": "Alpha", "replicas": 2},
            {"name": "Beta", "replicas": "lots"},
        ]
        controller.orchestrator = MagicMock()
        with self.assertLogs("canyonos_core.controller.global_controller", "WARNING"):
            controller._apply_configured_replicas()
        controller.orchestrator.apply_configured_replicas.assert_called_once_with(
            {"Alpha": 2}
        )


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
        self.assertIsNone(self.controller._replace_replica("Ghost", "Ghost-0"))
        self.manager.set_replicas.assert_not_called()
        self.manager.replace_replica.assert_not_called()

    def test_replacing_a_replica(self):
        self.controller._replace_replica("Alpha", "Alpha-1")
        self.manager.replace_replica.assert_called_once_with("Alpha", "Alpha-1")

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
