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
    return replicas.launch(controller, machine, spec, 50051, f"{spec['name']}-0")


class LaunchTests(unittest.TestCase):
    def test_a_database_on_its_own_machine_is_routed_on_its_published_db_port(self):
        spec = {
            "name": "Pg",
            "provider": "ec2-pool",
            "type": "database",
            "db_port": 5433,
        }

        replica = _launch(_controller(), spec, MACHINE)

        self.assertEqual(replica["host_port"], "5433")
        self.assertEqual(replica["address"], "10.0.0.30:5433")

    def test_a_container_timeout_waits_for_the_address(self):
        machine = {**MACHINE, "container_timeout": 180}

        with patch.object(replicas, "_wait_until_reachable") as check:
            _launch(_controller(), {"name": "A", "provider": "ec2-pool"}, machine)

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
            _launch(controller, {"name": "A", "provider": "ec2-pool"}, machine)

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


LOCAL = {"private_host": "localhost", "public_host": "localhost"}


class PublishesPortTests(unittest.TestCase):
    ENDPOINT = {"name": "endpoint", "type": "endpoint", "provider": "local"}

    def _publishes(self, machine, spec, provider="local", private_ip="10.0.0.1"):
        controller = SimpleNamespace(config={"provider": provider})
        env = {"CANYONOS_PRIVATE_IP": private_ip} if private_ip else {}
        with patch.dict(os.environ, env):
            if not private_ip:
                os.environ.pop("CANYONOS_PRIVATE_IP", None)
            return replicas.publishes_port(controller, machine, spec)

    def test_a_local_agent_publishes_nothing(self):
        self.assertFalse(self._publishes(LOCAL, {"name": "A"}))

    def test_an_agent_on_another_machine_is_published(self):
        self.assertTrue(self._publishes(MACHINE, {"name": "A"}, provider="ec2-pool"))

    def test_a_local_database_is_published_on_its_db_port(self):
        self.assertTrue(self._publishes(LOCAL, {"name": "Pg", "type": "database"}))

    def test_the_endpoint_is_published_for_agents_on_other_machines(self):
        # The manifest spells it in any casing.
        self.assertTrue(self._publishes(LOCAL, self.ENDPOINT, provider="EC2-Pool"))
        # ec2-assign declares its machines one per replica, not as a pool.
        self.assertTrue(self._publishes(LOCAL, self.ENDPOINT, provider="ec2-assign"))

    def test_the_endpoint_publishes_nothing_when_every_agent_is_local(self):
        """A private IP is found on almost every laptop, but no agent calls back there."""
        self.assertFalse(self._publishes(LOCAL, self.ENDPOINT))

    def test_the_endpoint_publishes_nothing_without_a_private_ip(self):
        self.assertFalse(
            self._publishes(LOCAL, self.ENDPOINT, provider="ec2-pool", private_ip=None)
        )

    def test_without_a_provider_every_agent_is_local(self):
        controller = SimpleNamespace(config={})
        with patch.dict(os.environ, {"CANYONOS_PRIVATE_IP": "10.0.0.1"}):
            self.assertFalse(replicas.publishes_port(controller, LOCAL, self.ENDPOINT))

    def _launch_endpoint(self, provider):
        controller = _controller()
        controller.config = {"provider": provider}
        controller.agent_specs_by_name = {"W": {"functions": [{"name": "main"}]}}
        controller.redis = MagicMock()
        controller.redis.hgetall.return_value = {
            "api_port": "9090",
            "arguments": "[]",
            "public_host": "127.0.0.1",
            "method": "main",
        }
        spec = {**self.ENDPOINT, "api_port": 9090, "agent": "W", "method": "main"}
        with (
            patch.object(replicas, "CONTROLLER_IMAGE", "canyonos-core:dev"),
            patch.dict(os.environ, {"CANYONOS_PRIVATE_IP": "10.0.0.1"}),
        ):
            replica = _launch(controller, spec, LOCAL)
        run = controller._run_cmd.call_args_list[-1].args[0]
        published = [run[i + 1] for i, arg in enumerate(run) if arg == "-p"]
        return replica, published

    def test_a_local_deployments_endpoint_publishes_only_its_api_port(self):
        replica, published = self._launch_endpoint("local")

        self.assertEqual(published, ["9090:8080"])
        self.assertEqual(replica["address"], "canyonos-endpoint-0:50051")

    def test_an_ec2_deployments_endpoint_is_called_back_at_the_private_ip(self):
        replica, published = self._launch_endpoint("ec2-pool")

        # Only the gRPC port is bound to the private IP; api_port is for every caller.
        self.assertEqual(published, ["10.0.0.1:50051:50051", "9090:8080"])
        self.assertEqual(replica["address"], "10.0.0.1:50051")

    def test_a_local_databases_db_port_stays_on_every_interface(self):
        controller = _controller()
        spec = {"name": "Pg", "provider": "local", "type": "database", "db_port": 5433}

        with patch.object(replicas, "_port_bound", return_value=False):
            _launch(controller, spec, LOCAL)

        run = controller._run_cmd.call_args_list[-1].args[0]
        self.assertEqual(run[run.index("-p") + 1], "5433:5432")

    def test_a_published_replica_is_bound_to_its_private_ip(self):
        controller = _controller()

        replica = _launch(controller, {"name": "A", "provider": "ec2-pool"}, MACHINE)

        run = controller._run_cmd.call_args_list[-1].args[0]
        self.assertEqual(run[run.index("-p") + 1], "10.0.0.30:50051:50051")
        self.assertEqual(replica["published_address"], "10.0.0.30:50051")


if __name__ == "__main__":
    unittest.main()
