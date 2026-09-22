"""CAN-402: every container the controller launches carries --cpus/--memory bounds."""

import os
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from canyonos_core.controller.cloud_provider_logic.EC2 import _runtime as ec2_runtime
from canyonos_core.controller.cloud_provider_logic.Local import (
    _runtime as local_runtime,
)
from canyonos_core.controller.cloud_provider_logic.shared_utils.resource_limits import (
    resource_limit_args,
)
from canyonos_core.controller.global_controller import GlobalController


def _limits_of(cmd):
    """Return the {flag: value} pairs the given `docker run` argv bounds the container with."""
    return {
        flag: cmd[cmd.index(flag) + 1]
        for flag in ("--cpus", "--memory", "--gpus")
        if flag in cmd
    }


class ResourceLimitArgsTests(unittest.TestCase):
    def test_absent_resources_fall_back_to_the_defaults(self):
        self.assertEqual(resource_limit_args(), ["--cpus", "1", "--memory", "512m"])
        self.assertEqual(resource_limit_args({}), ["--cpus", "1", "--memory", "512m"])

    def test_global_controller_yaml_values_win_over_the_defaults(self):
        self.assertEqual(
            resource_limit_args({"cpu": 2, "memory": 2048}),
            ["--cpus", "2", "--memory", "2048m"],
        )

    def test_a_partial_resources_block_defaults_only_the_missing_half(self):
        self.assertEqual(
            resource_limit_args({"memory": 2048}),
            ["--cpus", "1", "--memory", "2048m"],
        )

    def test_a_gpu_request_is_passed_through(self):
        self.assertEqual(
            resource_limit_args({"gpu": 2}),
            ["--cpus", "1", "--memory", "512m", "--gpus", "2"],
        )

    def test_zero_gpus_omits_the_flag_rather_than_requesting_none(self):
        """`--gpus 0` fails outright on a host with no NVIDIA runtime."""
        for resources in ({}, {"gpu": 0}, {"gpu": None}):
            with self.subTest(resources=resources):
                self.assertNotIn("--gpus", resource_limit_args(resources))


class LocalRuntimeLimitTests(unittest.TestCase):
    def setUp(self):
        self.original_controller = local_runtime._controller
        self.controller = SimpleNamespace(
            config={"poll_interval": 5},
            redis=MagicMock(),
            _run_cmd=MagicMock(return_value=SimpleNamespace(returncode=0, stdout="")),
        )
        local_runtime._controller = self.controller

    def tearDown(self):
        local_runtime._controller = self.original_controller

    def _launch(self, spec):
        provisioned = local_runtime.provision_instance(spec, 0, lambda host: 8000)
        with patch.object(local_runtime, "_port_bound", return_value=False):
            local_runtime.bootstrap_instance(provisioned, spec, 0, "agent-id-0")
        return self.controller._run_cmd.call_args.args[0]

    def test_an_agent_without_a_resources_block_is_still_bounded(self):
        cmd = self._launch({"name": "Alpha", "provider": "local"})

        self.assertEqual(_limits_of(cmd), {"--cpus": "1", "--memory": "512m"})

    def test_a_local_gpu_agent_still_gets_its_gpu_flag(self):
        cmd = self._launch(
            {
                "name": "Vllm",
                "provider": "local",
                "resources": {"cpu": 2, "memory": 2048, "gpu": 1},
            }
        )

        self.assertEqual(
            _limits_of(cmd),
            {"--cpus": "2", "--memory": "2048m", "--gpus": "1"},
        )

    def test_an_agent_with_a_resources_block_is_bounded_to_it(self):
        cmd = self._launch(
            {
                "name": "Alpha",
                "provider": "local",
                "resources": {"cpu": 2, "memory": 2048},
            }
        )

        self.assertEqual(_limits_of(cmd), {"--cpus": "2", "--memory": "2048m"})


class EC2RuntimeLimitTests(unittest.TestCase):
    def setUp(self):
        self.original_controller = ec2_runtime._controller
        key_file = tempfile.NamedTemporaryFile(delete=False)
        key_file.close()
        self.key_path = key_file.name
        os.chmod(self.key_path, 0o600)
        self.controller = SimpleNamespace(
            config={
                "poll_interval": 5,
                "ec2": {"ssh_user": "ubuntu", "ssh_private_key_path": self.key_path},
            },
            redis_containers={},
            node_redis={},
            _run_cmd=MagicMock(
                return_value=SimpleNamespace(returncode=0, stdout="", stderr="")
            ),
        )
        ec2_runtime._controller = self.controller

    def tearDown(self):
        os.unlink(self.key_path)
        ec2_runtime._controller = self.original_controller

    def _bootstrap(self, spec):
        with (
            patch.object(ec2_runtime.time, "sleep"),
            patch.object(
                ec2_runtime.subprocess,
                "run",
                return_value=SimpleNamespace(returncode=0, stderr="", stdout=""),
            ),
            patch.object(ec2_runtime, "RedisClient", return_value=MagicMock()),
            patch.object(ec2_runtime, "_wait_for_redis"),
        ):
            ec2_runtime._bootstrap_instance(
                "10.0.0.30",
                spec,
                0,
                self.controller.config["ec2"],
                redis_host="10.0.0.30",
                redis_port=6379,
                agent_id="agent-id-0",
            )
        redis_cmd, agent_cmd = (
            call.args[0]
            for call in self.controller._run_cmd.call_args_list
            if call.args[0][:2] == ["docker", "run"]
        )
        return redis_cmd, agent_cmd

    def test_the_ec2_agent_container_is_bounded_by_its_resources_block(self):
        _, agent_cmd = self._bootstrap(
            {
                "name": "Tagged",
                "provider": "EC2",
                "resources": {"cpu": 2, "memory": 2048},
            }
        )

        self.assertEqual(_limits_of(agent_cmd), {"--cpus": "2", "--memory": "2048m"})

    def test_the_ec2_agent_gets_its_gpu_flag_too(self):
        _, agent_cmd = self._bootstrap(
            {"name": "Vllm", "provider": "EC2", "resources": {"gpu": 1}}
        )

        self.assertEqual(
            _limits_of(agent_cmd),
            {"--cpus": "1", "--memory": "512m", "--gpus": "1"},
        )

    def test_the_ec2_agent_and_redis_containers_default_when_unconfigured(self):
        redis_cmd, agent_cmd = self._bootstrap({"name": "Tagged", "provider": "EC2"})

        self.assertEqual(_limits_of(agent_cmd), {"--cpus": "1", "--memory": "512m"})
        self.assertEqual(_limits_of(redis_cmd), {"--cpus": "1", "--memory": "512m"})


class GlobalControllerRedisLimitTests(unittest.TestCase):
    def test_a_newly_launched_redis_container_is_bounded(self):
        controller = GlobalController.__new__(GlobalController)
        controller.controllers = [
            {"name": "Workflow", "replicas": 1, "redis_port": 6379}
        ]
        controller.redis_containers = {}
        controller.node_redis = {}
        controller.redis = None
        controller._run_cmd = MagicMock(
            return_value=SimpleNamespace(returncode=0, stdout="", stderr="")
        )

        with (
            patch(
                "canyonos_core.controller.global_controller.RedisClient",
                return_value=MagicMock(),
            ),
            patch("canyonos_core.controller.global_controller._wait_for_redis"),
        ):
            controller._launch_redis_containers()

        redis_cmd = next(
            call.args[0]
            for call in controller._run_cmd.call_args_list
            if call.args[0][:2] == ["docker", "run"]
        )
        self.assertEqual(_limits_of(redis_cmd), {"--cpus": "1", "--memory": "512m"})


if __name__ == "__main__":
    unittest.main()
