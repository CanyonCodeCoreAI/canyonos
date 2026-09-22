"""QA coverage for PR #141 (CAN-386) -- port hardening.

Everything here targets code the PR added or changed. The PR shipped zero tests
for its own new module, so these are written from the reachable paths.
"""

import socket
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from canyonos_core.controller.cloud_provider_logic.Local import (
    _runtime as local_runtime,
)
from canyonos_core.controller.utils import port_utils


def _bind(host, port=0, listen=True):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind((host, port))
    if listen:
        s.listen(1)
    return s, s.getsockname()[1]


class IsPortConflictTests(unittest.TestCase):
    def test_recognises_both_documented_docker_messages(self):
        self.assertTrue(
            port_utils.is_port_conflict(
                "docker: Error response from daemon: driver failed programming external "
                "connectivity on endpoint x: Bind for 0.0.0.0:8080 failed: port is already allocated."
            )
        )
        self.assertTrue(
            port_utils.is_port_conflict(
                "docker: Error response from daemon: failed to bind host port for "
                "0.0.0.0:6379:172.18.0.2:6379/tcp: address already in use"
            )
        )

    def test_none_and_empty_are_not_conflicts(self):
        self.assertFalse(port_utils.is_port_conflict(None))
        self.assertFalse(port_utils.is_port_conflict(""))

    def test_unrelated_failures_are_not_conflicts(self):
        self.assertFalse(
            port_utils.is_port_conflict(
                "docker: Error response from daemon: Conflict. The container name "
                '"/canyonos-redis-localhost" is already in use'
            )
        )
        self.assertFalse(
            port_utils.is_port_conflict("Cannot connect to the Docker daemon")
        )

    def test_bytes_stderr_raises_instead_of_returning_false(self):
        """subprocess without text=True yields bytes; the helper is str-only."""
        with self.assertRaises(TypeError):
            port_utils.is_port_conflict(b"port is already allocated")


class IsPortFreeTests(unittest.TestCase):
    def test_free_port_reports_free(self):
        s, port = _bind("127.0.0.1")
        s.close()
        self.assertTrue(port_utils.is_port_free(port))

    def test_loopback_listener_reports_taken(self):
        s, port = _bind("127.0.0.1")
        self.addCleanup(s.close)
        self.assertFalse(port_utils.is_port_free(port))

    def test_wildcard_listener_reports_taken(self):
        s, port = _bind("0.0.0.0")
        self.addCleanup(s.close)
        self.assertFalse(port_utils.is_port_free(port))

    def test_non_loopback_listener_is_caught_by_the_wildcard_probe(self):
        """Regression guard for the loopback-only probe's blind spot (reverted)."""
        addr = socket.gethostbyname(socket.gethostname())
        if addr.startswith("127."):
            self.skipTest("no non-loopback address on this host")
        s, port = _bind(addr)
        self.addCleanup(s.close)
        wildcard = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            wildcard.bind(("0.0.0.0", port))
            wildcard.close()
            self.skipTest("kernel allowed the wildcard bind anyway")
        except OSError:
            pass  # this is what `docker run -p` would hit
        self.assertFalse(
            port_utils.is_port_free(port),
            "probe called the port free, but a 0.0.0.0 publish would fail",
        )

    def test_string_port_raises_typeerror(self):
        """YAML gives back `api_port: '8080'` as str; main's caller int()-ed it, the PR's does not."""
        with self.assertRaises(TypeError):
            port_utils.is_port_free("8080")


class FindFreePortTests(unittest.TestCase):
    def test_returns_start_when_start_is_free(self):
        s, port = _bind("127.0.0.1")
        s.close()
        self.assertEqual(port_utils.find_free_port(port), port)

    def test_hops_past_a_taken_port(self):
        s, port = _bind("127.0.0.1")
        self.addCleanup(s.close)
        self.assertGreater(port_utils.find_free_port(port), port)

    def test_raises_when_no_port_is_free(self):
        with (
            patch.object(port_utils, "is_port_free", return_value=False),
            self.assertRaises(RuntimeError) as ctx,
        ):
            port_utils.find_free_port(9000, max_attempts=3)
        self.assertIn("9000", str(ctx.exception))

    def test_zero_max_attempts_raises_rather_than_looping(self):
        with self.assertRaises(RuntimeError):
            port_utils.find_free_port(9000, max_attempts=0)

    def test_scan_does_not_run_past_the_last_valid_port(self):
        """start near 65535 walks into port 65536 -> OSError, not a clean RuntimeError."""

        def occupied(port, host="127.0.0.1"):
            self.assertLessEqual(port, 65535)
            return False

        with (
            patch.object(port_utils, "is_port_free", side_effect=occupied),
            self.assertRaises(RuntimeError),
        ):
            port_utils.find_free_port(65530, max_attempts=50)


class TwinModuleDriftTests(unittest.TestCase):
    """The module docstring requires the two copies stay byte-for-byte identical."""

    def test_the_two_copies_are_identical(self):
        root = Path(__file__).resolve().parents[3]
        core = root / "packages/core/canyonos_core/controller/utils/port_utils.py"
        cli = root / "packages/cli/canyonos/port_utils.py"
        self.assertEqual(
            core.read_bytes(),
            cli.read_bytes(),
            "port_utils twins have drifted; nothing in CI enforces this invariant",
        )


class WorkflowApiPortTests(unittest.TestCase):
    """_port_bound is the PR's fail-fast gate for a user-declared api_port."""

    def _spec(self, **over):
        spec = {"name": "wf", "type": "workflow", "host": "localhost", "api_port": 8080}
        spec.update(over)
        return spec

    def test_string_api_port_crashes_with_typeerror_not_a_clean_error(self):
        with self.assertRaises(TypeError):
            local_runtime._port_bound(self._spec(api_port="8080")["api_port"])


class RedisPortTests(unittest.TestCase):
    """redis_port is user-declared: publish it as written, or exit."""

    def _controller(self, run_cmd):
        from canyonos_core.controller.global_controller import GlobalController

        gc = GlobalController.__new__(GlobalController)
        gc.controllers = [
            {"user": None, "redis_port": 6379, "replicas": 1, "host": "localhost"}
        ]
        gc.redis_containers = {}
        gc.redis_ports = {}
        gc.node_redis = {}
        gc.redis = None
        gc._run_cmd = run_cmd
        gc._get_replica_placements = lambda ctrl: [("localhost", 5001)]
        return gc

    def _run_cmd_factory(self, conflicts):
        state = {"n": 0}

        def run_cmd(cmd, host=None, user=None):
            res = MagicMock()
            run_cmd.calls.append(list(cmd))
            if cmd[:2] == ["docker", "inspect"]:
                # No pre-existing container, so every case here takes the launch path.
                res.returncode = 0
                res.stdout = "false\n"
                res.stderr = ""
            elif cmd[:2] == ["docker", "run"]:
                state["n"] += 1
                if state["n"] <= conflicts:
                    res.returncode = 1
                    res.stderr = (
                        "Bind for 0.0.0.0:6379 failed: port is already allocated"
                    )
                else:
                    res.returncode = 0
                    res.stderr = ""
                    run_cmd.published = cmd[cmd.index("-p") + 1]
            else:
                res.returncode = 0
                res.stderr = ""
                res.stdout = ""
            return res

        run_cmd.published = None
        run_cmd.calls = []
        return run_cmd

    def test_publishes_the_declared_port(self):
        run_cmd = self._run_cmd_factory(conflicts=0)
        gc = self._controller(run_cmd)
        with (
            patch("canyonos_core.controller.global_controller.RedisClient"),
            patch("canyonos_core.controller.global_controller._wait_for_redis"),
        ):
            gc._launch_redis_containers()
        self.assertEqual(run_cmd.published, "6379:6379")
        self.assertEqual(gc.redis_ports["localhost"], 6379)

    def test_port_conflict_exits_without_retrying(self):
        run_cmd = self._run_cmd_factory(conflicts=999)
        gc = self._controller(run_cmd)
        with (
            patch("canyonos_core.controller.global_controller.RedisClient"),
            patch("canyonos_core.controller.global_controller._wait_for_redis"),
            self.assertRaises(SystemExit),
        ):
            gc._launch_redis_containers()
        runs = [c for c in run_cmd.calls if c[:2] == ["docker", "run"]]
        self.assertEqual(len(runs), 1, "a conflict must not be retried on another port")

    def test_conflict_removes_the_created_container_before_exiting(self):
        """Otherwise the next deploy fails on the container name, not the port."""
        run_cmd = self._run_cmd_factory(conflicts=999)
        gc = self._controller(run_cmd)
        with (
            patch("canyonos_core.controller.global_controller.RedisClient"),
            patch("canyonos_core.controller.global_controller._wait_for_redis"),
            self.assertRaises(SystemExit),
        ):
            gc._launch_redis_containers()
        self.assertIn(["docker", "rm", "-f", "canyonos-redis-localhost"], run_cmd.calls)

    def test_string_redis_port_is_coerced_not_crashed_on(self):
        run_cmd = self._run_cmd_factory(conflicts=0)
        gc = self._controller(run_cmd)
        gc.controllers[0]["redis_port"] = "6379"
        with (
            patch("canyonos_core.controller.global_controller.RedisClient"),
            patch("canyonos_core.controller.global_controller._wait_for_redis"),
        ):
            gc._launch_redis_containers()
        self.assertEqual(run_cmd.published, "6379:6379")

    def test_container_name_conflict_still_hard_exits(self):
        def run_cmd(cmd, host=None, user=None):
            res = MagicMock()
            res.stdout = ""
            if cmd[:2] == ["docker", "run"]:
                res.returncode = 125
                res.stderr = (
                    "docker: Error response from daemon: Conflict. The container "
                    'name "/canyonos-redis-localhost" is already in use'
                )
            else:
                res.returncode = 0
                res.stderr = ""
            return res

        gc = self._controller(run_cmd)
        with (
            patch("canyonos_core.controller.global_controller.RedisClient"),
            patch("canyonos_core.controller.global_controller._wait_for_redis"),
            self.assertRaises(SystemExit),
        ):
            gc._launch_redis_containers()


if __name__ == "__main__":
    unittest.main()
