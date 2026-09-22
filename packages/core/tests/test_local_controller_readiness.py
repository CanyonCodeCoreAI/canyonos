import os
import sys
import types
import unittest
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
    def __init__(self, resonse=""):
        self.resonse = resonse


if "local_controler_pb2" not in sys.modules:
    local_pb2 = types.ModuleType("local_controler_pb2")
    local_pb2.JsonResponse = _JsonResponse
    sys.modules["local_controler_pb2"] = local_pb2
if "local_controler_pb2_grpc" not in sys.modules:
    local_pb2_grpc = types.ModuleType("local_controler_pb2_grpc")
    local_pb2_grpc.LocalControllerServicer = object
    local_pb2_grpc.LocalControllerStub = object
    sys.modules["local_controler_pb2_grpc"] = local_pb2_grpc

from canyonos_core.controller.local_controller import LocalController


class _FakeRedis:
    def __init__(self):
        self.strings = {}
        self.hashes = {}

    def set(self, key, value):
        self.strings[key] = value

    def get(self, key):
        return self.strings.get(key)

    def hset_multiple(self, name, mapping):
        self.hashes.setdefault(name, {}).update(mapping)


def _build_controller(redis, publish_ready=False, agent=None, server=None):
    servicer = SimpleNamespace(request_queue=[])
    with (
        patch(
            "canyonos_core.controller.local_controller.start_server",
            return_value=(server or MagicMock(), servicer),
        ),
        patch(
            "canyonos_core.controller.local_controller.RedisClient",
            return_value=redis,
        ),
        patch("canyonos_core.controller.local_controller.threading.Thread"),
        patch.object(LocalController, "_start_llm_proxy", return_value=None),
        patch.object(LocalController, "_load_agent", return_value=agent),
    ):
        return LocalController(port=50051, publish_ready=publish_ready)


def _beat_once(controller):
    """Run exactly one pass of the metrics loop, then let it stop."""
    controller._metrics_stop_event.wait = lambda *args, **kwargs: (
        controller._metrics_stop_event.set()
    )
    controller._metrics_loop()


STATUS_KEY = "controller:localhost:50051:status"

DECLARED_AGENT = {
    "CANYONOS_AGENT_NAME": "RagChatbotAgent",
    "CANYONOS_AGENT_FILE": "chatbot.py",
}


class LocalControllerReadinessTests(unittest.TestCase):
    def test_publish_ready_false_does_not_write_status(self):
        redis = _FakeRedis()
        _build_controller(redis, publish_ready=False)
        self.assertEqual(redis.strings, {})

    def test_mark_ready_writes_healthy_to_controller_status_key(self):
        redis = _FakeRedis()
        controller = _build_controller(redis, publish_ready=False)
        controller.mark_ready()
        self.assertEqual(
            redis.strings, {"controller:localhost:50051:status": "healthy"}
        )

    def test_mark_failed_writes_failed_to_controller_status_key(self):
        redis = _FakeRedis()
        controller = _build_controller(redis, publish_ready=False)
        controller.mark_failed()
        self.assertEqual(redis.strings, {"controller:localhost:50051:status": "failed"})

    def test_mark_stopped_moves_the_held_status_too(self):
        # stop() wrote the key directly, so a heartbeat racing the shutdown
        # could republish the status the controller still held in memory.
        redis = _FakeRedis()
        controller = _build_controller(redis, publish_ready=False)
        controller.mark_stopped()
        self.assertEqual(controller._status, "stopped")
        _beat_once(controller)
        self.assertEqual(redis.strings[STATUS_KEY], "stopped")

    def test_a_declared_agent_that_fails_to_load_is_fatal(self):
        # The status used to be written before the load was attempted, and the
        # process stayed up afterwards: the container reported healthy,
        # GlobalController called it ready, `deploy` printed "N agent(s) ready",
        # and the first request came back "No agent loaded".
        redis = _FakeRedis()
        server = MagicMock()
        with patch.dict(os.environ, DECLARED_AGENT):
            with self.assertRaisesRegex(
                RuntimeError, "Failed to load configured agent RagChatbotAgent"
            ):
                _build_controller(redis, publish_ready=True, agent=None, server=server)
        self.assertEqual(redis.strings[STATUS_KEY], "failed")
        server.stop.assert_called_once_with(0)

    def test_an_unreachable_redis_does_not_keep_an_unloadable_container_alive(self):
        # Publishing "failed" is best effort; the container has to come down
        # either way, or it stays listening and answers "No agent loaded".
        redis = _FakeRedis()
        redis.set = MagicMock(side_effect=ConnectionError("redis is gone"))
        server = MagicMock()
        with patch.dict(os.environ, DECLARED_AGENT):
            with self.assertRaisesRegex(
                RuntimeError, "Failed to load configured agent"
            ):
                _build_controller(redis, publish_ready=True, agent=None, server=server)
        server.stop.assert_called_once_with(0)

    def test_half_a_declaration_is_a_failed_agent_not_an_agentless_one(self):
        # Only both absent means agentless. With one set, the container was
        # meant to serve an agent it can never load; read as agentless it
        # published "healthy" with nothing behind it.
        for env in (
            {"CANYONOS_AGENT_NAME": "RagChatbotAgent", "CANYONOS_AGENT_FILE": ""},
            {"CANYONOS_AGENT_NAME": "", "CANYONOS_AGENT_FILE": "chatbot.py"},
        ):
            with self.subTest(env=env):
                redis = _FakeRedis()
                with patch.dict(os.environ, env):
                    with self.assertRaisesRegex(
                        RuntimeError, "Failed to load configured agent"
                    ):
                        _build_controller(redis, publish_ready=True, agent=None)
                self.assertEqual(redis.strings[STATUS_KEY], "failed")

    def test_a_launcher_that_owns_readiness_decides_it_alone(self):
        # publish_ready=False: the generated workflow launcher marks the
        # container itself, so nothing here is fatal or published.
        redis = _FakeRedis()
        with patch.dict(os.environ, DECLARED_AGENT):
            _build_controller(redis, publish_ready=False, agent=None)
        self.assertEqual(redis.strings, {})

    def test_a_declared_agent_that_loads_publishes_healthy(self):
        redis = _FakeRedis()
        with patch.dict(os.environ, DECLARED_AGENT):
            _build_controller(redis, publish_ready=True, agent=object())
        self.assertEqual(redis.strings[STATUS_KEY], "healthy")

    def test_an_agentless_container_publishes_healthy(self):
        # A workflow container declares no agent; None from _load_agent is not a
        # failure there.
        redis = _FakeRedis()
        with patch.dict(
            os.environ, {"CANYONOS_AGENT_NAME": "", "CANYONOS_AGENT_FILE": ""}
        ):
            _build_controller(redis, publish_ready=True, agent=None)
        self.assertEqual(redis.strings[STATUS_KEY], "healthy")

    def test_a_heartbeat_before_readiness_does_not_announce_healthy(self):
        # The heartbeat starts before the agent is loaded. Until something marks
        # the container one way or the other it is starting, not ready.
        redis = _FakeRedis()
        controller = _build_controller(redis, publish_ready=False)
        _beat_once(controller)
        self.assertEqual(redis.strings[STATUS_KEY], "starting")

    def test_a_heartbeat_does_not_resurrect_a_failed_status(self):
        # The heartbeat published a literal "healthy", so it undid mark_failed()
        # within one interval and the container was announced ready again.
        redis = _FakeRedis()
        controller = _build_controller(redis, publish_ready=False)
        controller.mark_failed()
        _beat_once(controller)
        self.assertEqual(redis.strings[STATUS_KEY], "failed")

    def test_published_metrics_carry_the_real_status(self):
        redis = _FakeRedis()
        controller = _build_controller(redis, publish_ready=False)
        controller.mark_failed()
        _beat_once(controller)
        self.assertEqual(redis.hashes[controller._metrics_key]["status"], "failed")


if __name__ == "__main__":
    unittest.main()
