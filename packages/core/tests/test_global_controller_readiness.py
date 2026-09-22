import logging
import os
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from canyonos_core.controller.global_controller import GlobalController


class _FakeRedis:
    def __init__(self, statuses):
        self.statuses = statuses

    def get(self, key):
        return self.statuses.get(key)


class _FakeInstanceManager:
    def __init__(self, instances):
        self.instances = instances

    def list_instances(self):
        return list(self.instances)

    def _routing_endpoint_for(self, instance):
        return instance["endpoint"]


def _instance(name="ResearchAgent", host="localhost", port="8000", **extra):
    record = {
        "agent_name": name,
        "host": host,
        "host_port": port,
        "endpoint": f"{host}:{port}",
        "runtime_id": f"{name.lower()}-{port}",
    }
    record.update(extra)
    return record


def _controller(statuses, instances=None, stdout="", stderr=""):
    """A GlobalController with only the readiness path wired up.

    `calls` records the teardown and `docker logs` calls in the order they were
    made, so a test can pin the log dump to before the containers are removed.
    """
    controller = GlobalController.__new__(GlobalController)
    controller.redis = _FakeRedis(statuses)
    controller.node_redis = {}
    controller.instance_manager = _FakeInstanceManager(instances or [_instance()])
    controller._last_status = {}

    calls = MagicMock()
    calls.run_cmd.return_value = SimpleNamespace(stdout=stdout, stderr=stderr)
    controller._run_cmd = calls.run_cmd
    controller._stop_docker_agents = calls.stop_docker_agents
    controller._stop_redis_containers = calls.stop_redis_containers
    controller.calls = calls
    return controller


class GlobalControllerReadinessTests(unittest.TestCase):
    def test_healthy_controllers_complete_readiness(self):
        controller = _controller({"controller:localhost:8000:status": "healthy"})

        with self.assertLogs(
            "canyonos_core.controller.global_controller", level="INFO"
        ) as logs:
            controller._wait_for_healthy(timeout=0, interval=0)

        self.assertEqual(controller._last_status[("localhost", "8000")], "healthy")
        self.assertIn(
            "Controller ResearchAgent (localhost:8000) is ready.", logs.output[-1]
        )
        controller.calls.stop_docker_agents.assert_not_called()

    def test_a_failed_controller_aborts_without_waiting_out_the_timeout(self):
        # The status was only ever re-read on a timer, so a container that had
        # already died still cost the deploy its whole readiness timeout.
        controller = _controller({"controller:localhost:8000:status": "failed"})

        with (
            patch("canyonos_core.controller.global_controller.time.sleep") as sleep,
            self.assertLogs(
                "canyonos_core.controller.global_controller", level="INFO"
            ) as logs,
        ):
            with self.assertRaises(SystemExit) as caught:
                controller._wait_for_healthy(timeout=600, interval=2)

        self.assertEqual(caught.exception.code, 1)
        sleep.assert_not_called()
        self.assertEqual(
            logs.records[-1].getMessage(),
            "Controller readiness failed: ResearchAgent (localhost:8000)=failed",
        )

    def test_a_status_nobody_wrote_is_reported_as_unknown_and_is_fatal(self):
        controller = _controller({})

        with self.assertLogs(
            "canyonos_core.controller.global_controller", level="INFO"
        ) as logs:
            with self.assertRaises(SystemExit):
                controller._wait_for_healthy(timeout=0, interval=0)

        self.assertEqual(
            logs.records[-1].getMessage(),
            "Controller readiness failed: ResearchAgent (localhost:8000)=unknown",
        )

    def test_the_summary_names_every_controller_that_did_not_come_up(self):
        controller = _controller(
            {
                "controller:localhost:8000:status": "healthy",
                "controller:127.0.0.1:8001:status": "failed",
            },
            instances=[
                _instance(),
                _instance(name="WriterAgent", host="127.0.0.1", port="8001"),
                _instance(name="EditorAgent", host="127.0.0.1", port="8002"),
            ],
        )

        with self.assertLogs(
            "canyonos_core.controller.global_controller", level="INFO"
        ) as logs:
            with self.assertRaises(SystemExit):
                controller._wait_for_healthy(timeout=0, interval=0)

        self.assertEqual(
            logs.records[-1].getMessage(),
            "Controller readiness failed: WriterAgent (127.0.0.1:8001)=failed, "
            "EditorAgent (127.0.0.1:8002)=unknown",
        )
        self.assertEqual(logs.records[-1].levelno, logging.CRITICAL)

    def test_a_failed_container_s_own_log_is_dumped(self):
        # The cause only exists inside the container; deploy used to report a
        # count of healthy replicas and nothing else.
        controller = _controller(
            {"controller:localhost:8000:status": "failed"},
            stdout="Failed to load agent RagAgent\n",
            stderr="ModuleNotFoundError: No module named 'llama_index'\n",
        )

        with self.assertLogs(
            "canyonos_core.controller.global_controller", level="INFO"
        ) as logs:
            with self.assertRaises(SystemExit):
                controller._wait_for_healthy(timeout=0, interval=0)

        controller.calls.run_cmd.assert_called_once_with(
            ["docker", "logs", "--tail", "40", "researchagent-8000"],
            "localhost",
            None,
        )
        dumped = "\n".join(record.getMessage() for record in logs.records)
        self.assertIn("--- ResearchAgent (localhost:8000) status=failed ---", dumped)
        self.assertIn("Failed to load agent RagAgent", dumped)
        self.assertIn("ModuleNotFoundError: No module named 'llama_index'", dumped)

    def test_a_remote_container_s_log_is_read_over_its_own_ssh_user(self):
        controller = _controller(
            {},
            instances=[
                _instance(name="WriterAgent", host="10.0.0.7", port="8000", user="ec2")
            ],
        )

        with self.assertRaises(SystemExit):
            with self.assertLogs("canyonos_core.controller.global_controller"):
                controller._wait_for_healthy(timeout=0, interval=0)

        controller.calls.run_cmd.assert_called_once_with(
            ["docker", "logs", "--tail", "40", "writeragent-8000"],
            "10.0.0.7",
            "ec2",
        )

    def test_the_log_is_read_before_the_containers_are_removed(self):
        # cleanup() is registered atexit and runs `docker rm -f`, so a dump that
        # waited until teardown would have nothing left to read.
        controller = _controller({"controller:localhost:8000:status": "failed"})

        with self.assertRaises(SystemExit):
            with self.assertLogs("canyonos_core.controller.global_controller"):
                controller._wait_for_healthy(timeout=0, interval=0)

        self.assertEqual(
            [name for name, _, _ in controller.calls.mock_calls],
            ["run_cmd", "stop_docker_agents", "stop_redis_containers"],
        )

    def test_an_unreadable_log_does_not_swallow_the_failure(self):
        controller = _controller({"controller:localhost:8000:status": "failed"})
        controller.calls.run_cmd.side_effect = OSError("docker is gone")

        with self.assertLogs(
            "canyonos_core.controller.global_controller", level="INFO"
        ) as logs:
            with self.assertRaises(SystemExit):
                controller._wait_for_healthy(timeout=0, interval=0)

        self.assertIn(
            "Could not read the log of ResearchAgent: docker is gone",
            "\n".join(record.getMessage() for record in logs.records),
        )
        self.assertEqual(logs.records[-1].levelno, logging.CRITICAL)


if __name__ == "__main__":
    unittest.main()
