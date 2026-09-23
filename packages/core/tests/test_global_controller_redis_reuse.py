"""Fix C: a restart must not unconditionally wipe and recreate each node's Redis container.

_launch_redis_containers() used to `docker run` a fresh canyonos-redis-<host> container on every
__init__, unconditionally -- wiping every `agent_instance:*` record the Provisioner needs to
recognize already-running EC2 replicas as reusable. ensure_instances()'s dedup logic was already
correct; it was just fed an empty Redis on every restart, so it reprovisioned everything from
scratch and orphaned the previous replicas. The fix: check whether the existing container is
already healthy before recreating it.
"""

import os
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from canyonos_core.controller.global_controller import GlobalController


def _bare_controller(controllers):
    controller = GlobalController.__new__(GlobalController)
    controller.controllers = controllers
    controller.redis_containers = {}
    controller.redis_ports = {}
    controller.node_redis = {}
    controller.redis = None
    return controller


class RedisContainerReuseTests(unittest.TestCase):
    def _run(self, controller, inspect_stdout, served_port=6379):
        """`served_port` is the only port `docker port` reports; None means no mapping."""
        run_calls = []

        def fake_run_cmd(cmd, host, user=None):
            run_calls.append(cmd)
            if cmd[:2] == ["docker", "inspect"]:
                return SimpleNamespace(returncode=0, stdout=inspect_stdout, stderr="")
            if cmd[:2] == ["docker", "port"]:
                if served_port is not None and cmd[3] == f"{served_port}/tcp":
                    return SimpleNamespace(
                        returncode=0, stdout=f"0.0.0.0:{served_port}\n", stderr=""
                    )
                return SimpleNamespace(
                    returncode=1, stdout="", stderr=f"no public port {cmd[3]} published"
                )
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        controller._run_cmd = fake_run_cmd

        with (
            patch(
                "canyonos_core.controller.global_controller.RedisClient"
            ) as fake_redis_cls,
            patch("canyonos_core.controller.global_controller._wait_for_redis"),
        ):
            fake_redis_cls.return_value = MagicMock()
            controller._launch_redis_containers()

        return [c for c in run_calls if c[:2] == ["docker", "run"]]

    def test_a_healthy_existing_container_is_reused_without_becoming_owned(self):
        controller = _bare_controller(
            [{"name": "Workflow", "replicas": 1, "redis_port": 6379}]
        )

        docker_run_calls = self._run(controller, inspect_stdout="true\n")

        self.assertEqual(
            docker_run_calls,
            [],
            "a healthy existing Redis container must not be recreated",
        )
        self.assertNotIn("localhost", controller.redis_containers)
        self.assertIn("localhost", controller.node_redis)
        self.assertEqual(controller.redis_ports["localhost"], 6379)

        controller._run_cmd = MagicMock(
            return_value=SimpleNamespace(returncode=0, stdout="", stderr="")
        )
        self.assertEqual(controller._stop_redis_containers(), [])
        controller._run_cmd.assert_not_called()

    def test_an_unhealthy_or_missing_container_still_gets_created(self):
        controller = _bare_controller(
            [{"name": "Workflow", "replicas": 1, "redis_port": 6379}]
        )

        docker_run_calls = self._run(controller, inspect_stdout="false\n")

        self.assertEqual(
            len(docker_run_calls),
            1,
            "a not-running container must still be (re)created",
        )
        self.assertIn("localhost", controller.redis_containers)

    def test_reuse_check_probes_the_exact_expected_container_name(self):
        controller = _bare_controller(
            [
                {
                    "name": "Workflow",
                    "replicas": 1,
                    "redis_port": 6379,
                    "host": "10.0.0.5",
                }
            ]
        )

        inspect_calls = []

        def fake_run_cmd(cmd, host, user=None):
            if cmd[:2] == ["docker", "inspect"]:
                inspect_calls.append(cmd)
                return SimpleNamespace(returncode=0, stdout="true\n", stderr="")
            if cmd[:2] == ["docker", "port"]:
                return SimpleNamespace(returncode=0, stdout="0.0.0.0:6379\n", stderr="")
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        controller._run_cmd = fake_run_cmd

        with (
            patch(
                "canyonos_core.controller.global_controller.RedisClient"
            ) as fake_redis_cls,
            patch("canyonos_core.controller.global_controller._wait_for_redis"),
        ):
            fake_redis_cls.return_value = MagicMock()
            controller._launch_redis_containers()

        self.assertEqual(len(inspect_calls), 1)
        self.assertIn("canyonos-redis-10-0-0-5", inspect_calls[0])

    def test_conflicting_redis_ports_on_one_host_are_rejected(self):
        """One Redis per host, so two different declared ports cannot both hold."""
        controller = _bare_controller(
            [
                {"name": "A", "replicas": 1, "redis_port": 6379},
                {"name": "B", "replicas": 1, "redis_port": 6390},
            ]
        )

        with self.assertRaises(SystemExit):
            self._run(controller, inspect_stdout="false\n")

    def test_matching_redis_ports_on_one_host_are_fine(self):
        controller = _bare_controller(
            [
                {"name": "A", "replicas": 1, "redis_port": 6390},
                {"name": "B", "replicas": 1, "redis_port": 6390},
            ]
        )

        docker_run_calls = self._run(controller, inspect_stdout="false\n")

        self.assertEqual(len(docker_run_calls), 1, "one Redis per host, not per agent")

    def test_redis_listens_on_the_declared_port_inside_the_container_too(self):
        """Agents reach Redis by container name, so the inside port must match."""
        controller = _bare_controller(
            [{"name": "Workflow", "replicas": 1, "redis_port": 6390}]
        )

        docker_run_calls = self._run(controller, inspect_stdout="false\n")

        cmd = docker_run_calls[0]
        self.assertIn("6390:6390", cmd)
        self.assertEqual(cmd[-3:], ["redis-server", "--port", "6390"])

    def test_a_running_container_on_another_port_is_not_adopted(self):
        """The ping alone would pass if an unrelated Redis held the configured port."""
        controller = _bare_controller(
            [{"name": "Workflow", "replicas": 1, "redis_port": 6379}]
        )

        with self.assertRaises(SystemExit):
            self._run(controller, inspect_stdout="true\n", served_port=6390)

    def test_a_running_container_that_stops_answering_exits_rather_than_relaunching(
        self,
    ):
        """Relaunching would hit a name conflict and force-remove the live container."""
        controller = _bare_controller(
            [{"name": "Workflow", "replicas": 1, "redis_port": 6379}]
        )

        def fake_run_cmd(cmd, host, user=None):
            if cmd[:2] == ["docker", "inspect"]:
                return SimpleNamespace(returncode=0, stdout="true\n", stderr="")
            if cmd[:2] == ["docker", "port"]:
                return SimpleNamespace(returncode=0, stdout="0.0.0.0:6379\n", stderr="")
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        controller._run_cmd = fake_run_cmd

        with (
            patch("canyonos_core.controller.global_controller.RedisClient"),
            patch(
                "canyonos_core.controller.global_controller._wait_for_redis",
                side_effect=TimeoutError("no answer"),
            ),
            self.assertRaises(SystemExit),
        ):
            controller._launch_redis_containers()

    def test_a_redis_that_never_becomes_ready_exits_instead_of_raising(self):
        """The timeout message is useful; it shouldn't arrive as a bare traceback."""
        controller = _bare_controller(
            [{"name": "Workflow", "replicas": 1, "redis_port": 6379}]
        )

        def fake_run_cmd(cmd, host, user=None):
            if cmd[:2] == ["docker", "inspect"]:
                return SimpleNamespace(returncode=0, stdout="false\n", stderr="")
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        controller._run_cmd = fake_run_cmd

        with (
            patch("canyonos_core.controller.global_controller.RedisClient"),
            patch(
                "canyonos_core.controller.global_controller._wait_for_redis",
                side_effect=TimeoutError("Timed out connecting to Redis"),
            ),
            self.assertRaises(SystemExit),
        ):
            controller._launch_redis_containers()

    def test_a_running_container_publishing_nothing_is_not_adopted(self):
        controller = _bare_controller(
            [{"name": "Workflow", "replicas": 1, "redis_port": 6379}]
        )

        with self.assertRaises(SystemExit):
            self._run(controller, inspect_stdout="true\n", served_port=None)


if __name__ == "__main__":
    unittest.main()
