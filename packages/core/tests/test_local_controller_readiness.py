# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

import os
import sys
import tempfile
import threading
import types
import unittest
import urllib.error
import urllib.request
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
sys.path.insert(
    0,
    os.path.abspath(
        os.path.join(
            os.path.dirname(__file__), "..", "canyonos_core", "templates", "grpc_stubs"
        )
    ),
)


class _JsonResponse:
    def __init__(self, response=""):
        self.response = response


if "local_controller_pb2" not in sys.modules:
    local_pb2 = types.ModuleType("local_controller_pb2")
    local_pb2.JsonResponse = _JsonResponse
    sys.modules["local_controller_pb2"] = local_pb2
if "local_controller_pb2_grpc" not in sys.modules:
    local_pb2_grpc = types.ModuleType("local_controller_pb2_grpc")
    local_pb2_grpc.LocalControllerServicer = object
    local_pb2_grpc.LocalControllerStub = object
    sys.modules["local_controller_pb2_grpc"] = local_pb2_grpc

from redis import RedisError

from canyonos_core.controller.local_controller import LocalController
from fakes import _FakeRedis


def _build_controller(redis, **kwargs):
    servicer = SimpleNamespace(request_queue=[])
    with (
        patch(
            "canyonos_core.controller.local_controller.start_server",
            return_value=(MagicMock(), servicer),
        ),
        patch(
            "canyonos_core.controller.local_controller.RedisClient",
            return_value=redis,
        ),
        patch("canyonos_core.controller.local_controller.threading.Thread"),
        patch.object(LocalController, "_start_llm_gateway", MagicMock()),
        patch.object(LocalController, "_load_agent", return_value=None),
    ):
        return LocalController(port=50051, **kwargs)


class LocalControllerReadinessTests(unittest.TestCase):
    def test_a_loaded_controller_reports_healthy(self):
        redis = _FakeRedis()
        _build_controller(redis)
        self.assertEqual(
            redis.strings, {"controller:localhost:50051:status": "healthy"}
        )

    def test_a_launcher_that_reports_readiness_itself_leaves_it_initializing(self):
        redis = _FakeRedis()
        controller = _build_controller(redis, publish_ready=False)
        self.assertEqual(
            redis.strings, {"controller:localhost:50051:status": "initializing"}
        )

        controller.mark_ready()
        self.assertEqual(
            redis.strings, {"controller:localhost:50051:status": "healthy"}
        )

    def test_mark_failed_writes_failed_to_controller_status_key(self):
        redis = _FakeRedis()
        controller = _build_controller(redis)
        controller.mark_failed()
        self.assertEqual(redis.strings, {"controller:localhost:50051:status": "failed"})

    def test_an_agent_that_fails_to_import_logs_the_traceback(self):
        """The first line names the agent; the traceback under it names the
        import that actually failed, which is what a deploy failure has to show.
        """
        with tempfile.TemporaryDirectory() as tmpdir:
            agent_file = os.path.join(tmpdir, "broken_agent.py")
            with open(agent_file, "w") as f:
                f.write("import a_module_nobody_installed\n")
            controller = SimpleNamespace(
                agent_name="BrokenAgent", agent_file=agent_file
            )

            with self.assertLogs(
                "canyonos_core.controller.local_controller", level="ERROR"
            ) as logs:
                agent = LocalController._load_agent(controller)

        self.assertIsNone(agent)
        output = "\n".join(logs.output)
        self.assertIn("Failed to load agent BrokenAgent", output)
        self.assertIn("Traceback (most recent call last):", output)
        self.assertIn("a_module_nobody_installed", output)


class LocalControllerHealthTests(unittest.TestCase):
    """One health(): Redis gets its status (Docker, EC2), Kubernetes probes its HTTP
    checks, and the two always agree."""

    STATUS_KEY = "controller:localhost:50051:status"

    def _build(self, **kwargs):
        with patch.dict(os.environ):
            os.environ.pop("CANYONOS_HEALTH_PORT", None)
            self.redis = _FakeRedis()
            controller = _build_controller(self.redis, **kwargs)
        controller._metrics_thread = MagicMock(is_alive=lambda: True)
        controller._gateway_process = None
        return controller

    def _probes(self, controller):
        checks = controller._health_checks()
        return {path: check()[0] for path, check in checks.items()}

    def test_without_a_health_port_no_server_runs(self):
        self.assertIsNone(self._build()._health_server)

    def test_redis_and_the_probes_report_the_same_status(self):
        controller = self._build(publish_ready=False)
        self.assertEqual(self.redis.get(self.STATUS_KEY), "initializing")
        self.assertEqual(
            self._probes(controller),
            {"/startupz": False, "/readyz": False, "/livez": True},
        )

        controller.mark_ready()
        self.assertEqual(self.redis.get(self.STATUS_KEY), "healthy")
        self.assertEqual(
            self._probes(controller),
            {"/startupz": True, "/readyz": True, "/livez": True},
        )

        controller.mark_failed()
        self.assertEqual(self.redis.get(self.STATUS_KEY), "failed")
        self.assertEqual(
            self._probes(controller),
            {"/startupz": True, "/readyz": False, "/livez": True},
        )

    def test_not_alive_once_the_metrics_thread_or_the_gateway_stops(self):
        controller = self._build()
        controller._metrics_thread = MagicMock(is_alive=lambda: False)
        self.assertEqual(controller.health()[1:], (False, "metrics thread stopped"))

        controller._metrics_thread = MagicMock(is_alive=lambda: True)
        controller._gateway_process = MagicMock(returncode=1)
        controller._gateway_process.poll.return_value = 1
        self.assertEqual(
            controller.health()[1:], (False, "LLM gateway exited with code 1")
        )

    def test_a_redis_outage_cannot_stop_a_teardown(self):
        # mark_failed and mark_stopped start a teardown: the probes still see the new
        # status, the Redis error is logged, and the caller goes on cleaning up.
        controller = self._build()
        controller.redis = MagicMock(**{"set.side_effect": RedisError("down")})
        with self.assertLogs("canyonos_core.controller.local_controller", "WARNING"):
            controller.mark_failed()
            controller.mark_stopped()
        self.assertEqual(controller.health()[0], "stopped")

    def test_a_redis_outage_still_fails_mark_ready(self):
        controller = self._build(publish_ready=False)
        controller.redis = MagicMock(**{"set.side_effect": RedisError("down")})
        with self.assertRaises(RedisError):
            controller.mark_ready()

    def test_a_redis_outage_never_changes_health(self):
        controller = self._build()
        controller.redis = MagicMock(**{"get.side_effect": ConnectionError("down")})
        self.assertEqual(controller.health(), ("healthy", True, "alive"))

    def test_the_health_port_serves_the_probes(self):
        with patch.dict(os.environ, {"CANYONOS_HEALTH_PORT": "0"}):
            controller = _build_controller(_FakeRedis(), publish_ready=False)
        controller._metrics_thread = MagicMock(is_alive=lambda: True)
        server = controller._health_server
        # _build_controller stubs out threading.Thread, the health server's too, so
        # serve it here (test_health.py covers the real thread).
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.shutdown)
        url = f"http://127.0.0.1:{server.server_address[1]}"

        def status(path):
            try:
                with urllib.request.urlopen(url + path, timeout=5) as response:
                    return response.status
            except urllib.error.HTTPError as e:
                return e.code

        self.assertEqual(status("/startupz"), 503)
        controller.mark_ready()
        self.assertEqual(
            [status(p) for p in ("/startupz", "/readyz", "/livez")], [200, 200, 200]
        )


if __name__ == "__main__":
    unittest.main()
