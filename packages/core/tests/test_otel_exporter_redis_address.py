"""The otel_exporter subprocess must talk to the Redis the GC writes destinations to.

It used to hardcode `RedisClient(host="host.docker.internal")`, taking the default port
6379 regardless of the deployment's redis_port. On any other port it read no
destinations, stayed in flush mode, and deleted every queued span and metric each poll
-- silently, at INFO -- while the GC wrote to the real one.
"""

import os
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from canyonos_core.controller.global_controller import GlobalController


def _bare_controller(redis_port):
    controller = GlobalController.__new__(GlobalController)
    controller.controllers = [
        {"name": "IntentAgent", "replicas": 1, "redis_port": redis_port}
    ]
    controller.redis_containers = {}
    controller.node_redis = {}
    controller.redis = None
    # What __init__ seeds from the config block before _launch_redis_containers runs.
    controller._redis_addr = ("localhost", 6379)
    return controller


def _launch(controller):
    def fake_run_cmd(cmd, host, user=None):
        # Nothing already running, so a fresh container is created successfully.
        if cmd[:2] == ["docker", "inspect"]:
            return SimpleNamespace(returncode=1, stdout="", stderr="No such object")
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    controller._run_cmd = fake_run_cmd
    with (
        patch("canyonos_core.controller.global_controller.RedisClient") as fake_cls,
        patch("canyonos_core.controller.global_controller._wait_for_redis"),
        patch.dict(os.environ, {"CANYONOS_REDIS_HOST": "host.docker.internal"}),
    ):
        fake_cls.return_value = MagicMock()
        controller._launch_redis_containers()


class ExporterRedisAddressTests(unittest.TestCase):
    def test_the_tracked_address_follows_the_configured_redis_port(self):
        controller = _bare_controller(redis_port=6380)

        _launch(controller)

        self.assertEqual(controller._redis_addr, ("host.docker.internal", 6380))

    def test_the_tracked_address_matches_the_client_that_replaced_self_redis(self):
        # self.redis is swapped for the local node's client; the address the exporter
        # is handed has to be swapped with it or they drift apart.
        controller = _bare_controller(redis_port=6381)

        _launch(controller)

        self.assertIs(controller.redis, controller.node_redis["localhost"])
        self.assertEqual(controller._redis_addr[1], 6381)


class ExporterRequiresItsRedisAddressTests(unittest.TestCase):
    def test_the_exporter_refuses_to_start_without_the_address(self):
        # Better a dead exporter than one quietly deleting telemetry it can never send.
        sys.path.insert(
            0,
            os.path.abspath(
                os.path.join(
                    os.path.dirname(__file__), "..", "canyonos_core", "otlp_exporter"
                )
            ),
        )
        import otel_exporter

        env = {
            k: v
            for k, v in os.environ.items()
            if k not in ("CANYONOS_OTEL_REDIS_HOST", "CANYONOS_OTEL_REDIS_PORT")
        }
        with patch.dict(os.environ, env, clear=True):
            with patch.object(otel_exporter, "init_db"):
                with self.assertRaises(RuntimeError) as caught:
                    otel_exporter.main()

        self.assertIn("CANYONOS_OTEL_REDIS_HOST", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
