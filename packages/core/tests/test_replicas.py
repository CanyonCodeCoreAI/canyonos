# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

import os
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from canyonos_core.reconciler import replicas

MACHINE = {
    "machine_id": "i-test1",
    "private_host": "10.0.0.30",
    "public_host": "54.10.20.30",
    "user": "ubuntu",
}


def _controller():
    return SimpleNamespace(
        config={},
        redis_ports={},
        machine_redis_for_replica=lambda _replica: MagicMock(),
        _run_cmd=MagicMock(
            return_value=SimpleNamespace(returncode=0, stdout="", stderr="")
        ),
    )


def _launch(controller, spec, machine):
    return replicas.launch(controller, machine, spec, 0, 50051, "agent-id-0")


class LaunchTests(unittest.TestCase):
    def test_a_database_on_its_own_machine_is_routed_on_its_published_db_port(self):
        spec = {"name": "Pg", "provider": "EC2", "type": "database", "db_port": 5433}

        replica = _launch(_controller(), spec, MACHINE)

        self.assertEqual(replica["host_port"], "5433")
        self.assertEqual(replica["address"], "10.0.0.30:5433")

    def test_a_container_timeout_waits_for_the_address(self):
        machine = {**MACHINE, "container_timeout": 180}

        with patch.object(replicas, "_wait_until_reachable") as check:
            _launch(_controller(), {"name": "A", "provider": "EC2"}, machine)

        check.assert_called_once_with("10.0.0.30:50051", 180)

    def test_a_container_that_never_answers_shows_its_log_before_failing(self):
        """Removing the failed launch can terminate the machine and its log with it."""
        controller = _controller()
        machine = {**MACHINE, "container_timeout": 180}

        with (
            patch.object(replicas, "_wait_until_reachable", side_effect=TimeoutError),
            patch.object(replicas, "dump_container_log") as dump,
            self.assertRaises(TimeoutError),
        ):
            _launch(controller, {"name": "A", "provider": "EC2"}, machine)

        replica, status, read_log = dump.call_args.args
        self.assertEqual(status, "unreachable")
        read_log(replica, 40)
        self.assertEqual(
            controller._run_cmd.call_args.args,
            (["docker", "logs", "--tail", "40", "canyonos-a-0"], "10.0.0.30", "ubuntu"),
        )

    def test_the_reachability_error_names_the_address(self):
        with (
            patch.object(replicas.time, "time", side_effect=[0, 999]),
            self.assertRaisesRegex(
                TimeoutError, "never became reachable at 10.0.0.30:50051"
            ),
        ):
            replicas._wait_until_reachable("10.0.0.30:50051", timeout=1)


if __name__ == "__main__":
    unittest.main()
