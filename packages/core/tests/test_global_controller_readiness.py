import os
import sys
import unittest

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


def _controller(statuses):
    instances = [
        {
            "agent_name": "ResearchAgent",
            "host": "localhost",
            "host_port": "8000",
            "endpoint": "localhost:8000",
        }
    ]
    controller = GlobalController.__new__(GlobalController)
    controller.redis = _FakeRedis(statuses)
    controller.node_redis = {}
    controller.instance_manager = _FakeInstanceManager(instances)
    controller._last_status = {}
    return controller


class GlobalControllerReadinessTests(unittest.TestCase):
    def test_healthy_controller_completes_readiness(self):
        controller = _controller({"controller:localhost:8000:status": "healthy"})

        controller._wait_for_healthy(timeout=0, interval=0)

        self.assertEqual(controller._last_status[("localhost", "8000")], "healthy")

    def test_failed_controller_fails_deploy_after_deadline(self):
        controller = _controller({"controller:localhost:8000:status": "failed"})

        with self.assertRaisesRegex(
            RuntimeError,
            r"Controller readiness timed out after 0s: ResearchAgent "
            r"\(localhost:8000\)=failed",
        ):
            controller._wait_for_healthy(timeout=0, interval=0)

    def test_missing_status_fails_deploy_after_deadline(self):
        controller = _controller({})

        with self.assertRaisesRegex(RuntimeError, r"ResearchAgent .*unknown"):
            controller._wait_for_healthy(timeout=0, interval=0)


if __name__ == "__main__":
    unittest.main()
