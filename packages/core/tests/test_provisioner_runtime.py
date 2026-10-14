# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

import os
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import ANY, MagicMock, patch

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from canyonos_core.reconciler.providers.Local import (
    _runtime as local_runtime,
)
from canyonos_core.controller.controller_context import (
    list_instances,
)
from canyonos_core.reconciler.provisioner import Provisioner
from fakes import _FakeRedis, _fake_controller


def _fake_runtime(**kwargs):
    runtime = SimpleNamespace(
        port_claim_host=MagicMock(return_value=None),
        ssh_user=MagicMock(return_value=None),
        hourly_cost=MagicMock(return_value=0),
        provision_instance=MagicMock(return_value={}),
        bootstrap_instance=MagicMock(return_value={}),
        terminate_instance=MagicMock(),
        _controller=None,
    )
    for key, value in kwargs.items():
        setattr(runtime, key, value)
    return runtime


class ProvisionerRuntimeTests(unittest.TestCase):
    def test_bootstrap_instance_removes_an_orphaned_running_container_before_recreating(
        self,
    ):
        """We only get here when Redis has no agent_instance record for this replica -- but a
        container with this exact name can still be running (e.g. Redis was wiped and rebuilt
        empty while the container it used to track kept running). `docker run --name` would just
        fail with "name already in use" in that case; treat it as an orphan and clear it first."""
        controller = _fake_controller()
        calls = []

        def fake_run_cmd(cmd, host, user=None):
            calls.append(cmd)
            if cmd[:2] == ["docker", "inspect"]:
                return SimpleNamespace(returncode=0, stdout=inspect_output(cmd))
            return SimpleNamespace(returncode=0, stdout="")

        def inspect_output(cmd):
            return "true\n" if cmd[3] == "{{.State.Running}}" else "canyonos\n"

        controller._run_cmd = fake_run_cmd
        manager = Provisioner(controller)

        manager.ensure_instances([{"name": "Alpha", "provider": "local"}])

        self.assertEqual(
            [c[:3] for c in calls],
            [
                ["docker", "inspect", "-f"],
                ["docker", "inspect", "-f"],
                ["docker", "rm", "-f"],
                ["docker", "run", "-d"],
            ],
        )

    def test_a_configured_redis_port_reaches_a_local_agent(self):
        """Redis listens on the declared port inside the container, so agents use it too."""
        controller = _fake_controller()
        manager = Provisioner(controller)

        instance = manager.ensure_instances(
            [{"name": "Alpha", "provider": "local", "redis_port": 9002}]
        )[0]

        self.assertEqual(instance["redis_port"], "9002")
        run_argv = controller._run_cmd.call_args_list[1].args[0]
        self.assertIn("CANYONOS_REDIS_PORT=9002", run_argv)

    def test_local_instances_keep_default_host_and_increment_host_ports(self):
        controller = _fake_controller()
        manager = Provisioner(controller)

        alpha = manager.ensure_instances([{"name": "Alpha", "provider": "local"}])[0]
        beta = manager.ensure_instances([{"name": "Beta", "provider": "local"}])[0]

        self.assertEqual(alpha.pop("agent_id"), "Alpha-0")

        self.assertEqual(
            alpha,
            {
                "agent_name": "Alpha",
                "provider": "local",
                "replica_index": "0",
                "private_host": "localhost",
                "public_host": "localhost",
                "host_port": "8000",
                "container_port": "50051",
                "endpoint": "localhost:8000",
                "routing_endpoint": "canyonos-alpha-0:50051",
                "redis_host": "canyonos-redis-localhost",
                "redis_port": "6379",
                "runtime_id": "canyonos-alpha-0",
            },
        )

        self.assertEqual(beta["private_host"], "localhost")
        self.assertEqual(beta["host_port"], "8001")
        self.assertNotIn(
            "-it",
            controller._run_cmd.call_args_list[1].args[0],
            "non-interactive agent containers must be created with stdin closed",
        )
        self.assertEqual(
            # index [1], not [0]: the orphan-check `docker inspect` probe now runs first.
            controller._run_cmd.call_args_list[1].args,
            (
                [
                    "docker",
                    "run",
                    "-d",
                    "--label",
                    "com.docker.compose.project=canyonos",
                    "--network",
                    "canyonos-local",
                    "--name",
                    "canyonos-alpha-0",
                    "--add-host",
                    "host.docker.internal:host-gateway",
                    "-p",
                    "8000:50051",
                    "-e",
                    "CANYONOS_AGENT_PORT=50051",
                    "-e",
                    "CANYONOS_AGENT_HOST=canyonos-alpha-0",
                    "-e",
                    "CANYONOS_REDIS_HOST=canyonos-redis-localhost",
                    "-e",
                    "CANYONOS_REDIS_PORT=6379",
                    "-e",
                    "CANYONOS_POLL_INTERVAL=5",
                    "-e",
                    "AWS_ENDPOINT_URL_BEDROCK_RUNTIME=http://127.0.0.1:8081/bedrock",
                    "-e",
                    "OPENAI_BASE_URL=http://127.0.0.1:8081/openai/v1",
                    "-e",
                    "OPENAI_API_BASE=http://127.0.0.1:8081/openai/v1",
                    "-e",
                    "ANTHROPIC_BASE_URL=http://127.0.0.1:8081/anthropic",
                    "-e",
                    "ANTHROPIC_API_URL=http://127.0.0.1:8081/anthropic",
                    "-e",
                    "ANTHROPIC_API_BASE=http://127.0.0.1:8081/anthropic",
                    "-e",
                    "CANYONOS_LOGS_ENABLED=true",
                    "--cpus",
                    "1",
                    "--memory",
                    "512m",
                    "canyonos-alpha",
                ],
                "localhost",
                None,
            ),
        )

    def test_local_instances_use_host_and_user_overrides(self):
        controller = _fake_controller()
        manager = Provisioner(controller)

        with patch.object(local_runtime, "transfer_image") as transfer_image:
            instance = manager.ensure_instances(
                [
                    {
                        "name": "Alpha",
                        "provider": "local",
                        "host": "10.0.0.5",
                        "user": "ubuntu",
                    }
                ]
            )[0]

        transfer_image.assert_called_once_with(
            controller, "canyonos-alpha", "10.0.0.5", "ubuntu"
        )
        run_cmd = next(
            call.args[0]
            for call in controller._run_cmd.call_args_list
            if call.args[0][:2] == ["docker", "run"]
        )
        self.assertNotIn("--network", run_cmd)
        self.assertIn("CANYONOS_AGENT_HOST=10.0.0.5", run_cmd)
        self.assertIn("CANYONOS_AGENT_PORT=8000", run_cmd)
        self.assertIn("CANYONOS_REDIS_HOST=host.docker.internal", run_cmd)
        self.assertEqual(instance["private_host"], "10.0.0.5")
        self.assertEqual(instance["endpoint"], "10.0.0.5:8000")
        self.assertEqual(instance["routing_endpoint"], "10.0.0.5:8000")
        self.assertEqual(instance["user"], "ubuntu")
        self.assertEqual(
            controller.redis.hgetall("agent_instance:local:Alpha:0")["private_host"],
            "10.0.0.5",
        )
        for call in controller._run_cmd.call_args_list:
            self.assertEqual(call.args[1:], ("10.0.0.5", "ubuntu"))

    def test_a_local_database_is_routed_on_its_container_port(self):
        controller = _fake_controller()
        manager = Provisioner(controller)

        with patch.object(local_runtime, "_port_bound", return_value=False):
            instance = manager.ensure_instances(
                [
                    {
                        "name": "Pg",
                        "provider": "local",
                        "type": "database",
                        "db_port": 5433,
                    }
                ]
            )[0]

        run_cmd = next(
            call.args[0]
            for call in controller._run_cmd.call_args_list
            if call.args[0][:2] == ["docker", "run"]
        )
        self.assertIn("CANYONOS_AGENT_HOST=canyonos-pg-0", run_cmd)
        self.assertIn("CANYONOS_AGENT_PORT=5432", run_cmd)
        self.assertEqual(instance["host_port"], "5433")
        self.assertEqual(instance["routing_endpoint"], "canyonos-pg-0:5432")

    def test_only_limits_which_agents_get_replicas_but_routing_keeps_every_agent(self):
        controller = _fake_controller()
        manager = Provisioner(controller)

        manager.ensure_instances(
            [
                {"name": "Alpha", "provider": "local"},
                {"name": "Beta", "provider": "local"},
            ],
            only={"Alpha"},
        )

        self.assertEqual(
            [instance["agent_name"] for instance in list_instances(controller.redis)],
            ["Alpha"],
        )
        self.assertEqual(
            controller.redis.smembers("routing_table:services"), {"Alpha", "Beta"}
        )

    def test_bootstrap_instance_passes_poll_interval_env_var(self):
        controller = _fake_controller()
        controller.config = {"poll_interval": 7}
        manager = Provisioner(controller)

        manager.ensure_instances([{"name": "Alpha", "provider": "local"}])

        cmd = controller._run_cmd.call_args.args[0]
        self.assertIn("CANYONOS_POLL_INTERVAL=7", cmd)

    def test_local_bootstrap_passes_logs_enabled_env_var_with_its_flag(self):
        """CANYONOS_LOGS_ENABLED must be preceded by its own '-e' -- a bare
        'KEY=value' string with no flag is treated by `docker run` as the IMAGE
        positional argument, breaking the launch entirely."""
        controller = _fake_controller()
        controller.config = {"logs": True}
        manager = Provisioner(controller)

        manager.ensure_instances([{"name": "Alpha", "provider": "local"}])

        cmd = controller._run_cmd.call_args.args[0]
        index = cmd.index("CANYONOS_LOGS_ENABLED=true")
        self.assertEqual(cmd[index - 1], "-e")

    def test_local_bootstrap_defaults_logs_enabled_to_true(self):
        controller = _fake_controller()
        controller.config = {}
        manager = Provisioner(controller)

        manager.ensure_instances([{"name": "Alpha", "provider": "local"}])

        cmd = controller._run_cmd.call_args.args[0]
        index = cmd.index("CANYONOS_LOGS_ENABLED=true")
        self.assertEqual(cmd[index - 1], "-e")

    def test_local_bootstrap_honors_explicit_logs_false(self):
        controller = _fake_controller()
        controller.config = {"logs": False}
        manager = Provisioner(controller)

        manager.ensure_instances([{"name": "Alpha", "provider": "local"}])

        cmd = controller._run_cmd.call_args.args[0]
        index = cmd.index("CANYONOS_LOGS_ENABLED=false")
        self.assertEqual(cmd[index - 1], "-e")

    def test_local_agent_and_resource_flags_stay_the_same(self):
        controller = _fake_controller()
        manager = Provisioner(controller)

        manager.ensure_instances(
            [
                {
                    "name": "Workflow",
                    "provider": "local",
                    "resources": {"cpu": 2, "memory": 1024, "gpu": 1},
                }
            ]
        )

        self.assertNotIn(
            "-it",
            controller._run_cmd.call_args.args[0],
            "non-interactive agent containers must be created with stdin closed",
        )
        self.assertEqual(
            controller._run_cmd.call_args.args,
            (
                [
                    "docker",
                    "run",
                    "-d",
                    "--label",
                    "com.docker.compose.project=canyonos",
                    "--network",
                    "canyonos-local",
                    "--name",
                    "canyonos-workflow-0",
                    "--add-host",
                    "host.docker.internal:host-gateway",
                    "-p",
                    "8000:50051",
                    "-e",
                    "CANYONOS_AGENT_PORT=50051",
                    "-e",
                    "CANYONOS_AGENT_HOST=canyonos-workflow-0",
                    "-e",
                    "CANYONOS_REDIS_HOST=canyonos-redis-localhost",
                    "-e",
                    "CANYONOS_REDIS_PORT=6379",
                    "-e",
                    "CANYONOS_POLL_INTERVAL=5",
                    "-e",
                    "AWS_ENDPOINT_URL_BEDROCK_RUNTIME=http://127.0.0.1:8081/bedrock",
                    "-e",
                    "OPENAI_BASE_URL=http://127.0.0.1:8081/openai/v1",
                    "-e",
                    "OPENAI_API_BASE=http://127.0.0.1:8081/openai/v1",
                    "-e",
                    "ANTHROPIC_BASE_URL=http://127.0.0.1:8081/anthropic",
                    "-e",
                    "ANTHROPIC_API_URL=http://127.0.0.1:8081/anthropic",
                    "-e",
                    "ANTHROPIC_API_BASE=http://127.0.0.1:8081/anthropic",
                    "-e",
                    "CANYONOS_LOGS_ENABLED=true",
                    "--cpus",
                    "2",
                    "--memory",
                    "1024m",
                    "--gpus",
                    "1",
                    "canyonos-workflow",
                ],
                "localhost",
                None,
            ),
        )

    def test_agent_id_is_stable_across_repeated_ensure_instances_calls(self):
        controller = _fake_controller()
        manager = Provisioner(controller)

        first = manager.ensure_instances([{"name": "Alpha", "provider": "local"}])[0]
        second = manager.ensure_instances([{"name": "Alpha", "provider": "local"}])[0]

        self.assertEqual(first["agent_id"], second["agent_id"])

    def test_agent_id_is_published_under_the_controller_endpoint_key(self):
        controller = _fake_controller()
        manager = Provisioner(controller)

        alpha = manager.ensure_instances([{"name": "Alpha", "provider": "local"}])[0]

        self.assertEqual(
            controller.redis.get("controller:canyonos-alpha-0:50051:agent_id"),
            alpha["agent_id"],
        )

    def test_one_failed_replica_still_registers_and_routes_the_others(self):
        controller = _fake_controller()
        manager = Provisioner(controller)
        provision_one = manager._provision_one

        def fail_beta(job):
            if job["agent_name"] == "Beta":
                raise RuntimeError("beta failed")
            return provision_one(job)

        manager._provision_one = fail_beta

        with (
            patch(
                "canyonos_core.reconciler.provisioner.publish_routing_snapshot"
            ) as publish,
            self.assertLogs("canyonos_core.reconciler.provisioner", "WARNING") as logs,
            self.assertRaisesRegex(RuntimeError, "beta failed"),
        ):
            manager.ensure_instances(
                [
                    {"name": "Alpha", "provider": "local"},
                    {"name": "Beta", "provider": "local"},
                ]
            )

        self.assertEqual(
            controller.redis.smembers("agent:Alpha:instances"), {"local:Alpha:0"}
        )
        publish.assert_called_once()
        self.assertIn("Failed to provision local:Beta:0", "\n".join(logs.output))

    def test_missing_runtime_behind_stale_record_is_reprovisioned(self):
        controller = _fake_controller()
        manager = Provisioner(controller)
        key = "agent_instance:local:Alpha:0"
        stale = {
            "agent_id": "stale-agent-id",
            "agent_name": "Alpha",
            "provider": "local",
            "replica_index": "0",
            "private_host": "localhost",
            "public_host": "localhost",
            "host_port": "8000",
            "container_port": "50051",
            "endpoint": "localhost:8000",
            "routing_endpoint": "canyonos-alpha-0:50051",
            "redis_host": "canyonos-redis-localhost",
            "redis_port": "6379",
            "runtime_id": "canyonos-alpha-0",
        }
        controller.redis.hset_multiple(key, stale)
        controller.redis.sadd("agent:Alpha:instances", "local:Alpha:0")

        with self.assertLogs("canyonos_core.reconciler.provisioner", "WARNING") as logs:
            instance = manager.ensure_instances(
                [{"name": "Alpha", "provider": "local"}]
            )[0]

        self.assertIn("Replacing local:Alpha:0", logs.output[0])
        self.assertNotEqual(instance["agent_id"], "stale-agent-id")
        commands = [call.args[0] for call in controller._run_cmd.call_args_list]
        self.assertTrue(
            any(command[:3] == ["docker", "run", "-d"] for command in commands)
        )
        self.assertEqual(
            controller.redis.smembers("agent:Alpha:instances"), {"local:Alpha:0"}
        )

    def test_local_remove_instance_still_removes_the_same_container(self):
        controller = _fake_controller()
        manager = Provisioner(controller)
        manager.ensure_instances([{"name": "Alpha", "provider": "local"}])

        controller._run_cmd.reset_mock()
        manager.remove_instance("local:Alpha:0")

        self.assertEqual(
            controller._run_cmd.call_args.args,
            (["docker", "rm", "-f", "canyonos-alpha-0"], "localhost", None),
        )
        self.assertEqual(controller.redis.hgetall("agent_instance:local:Alpha:0"), {})

    def test_manager_keeps_ec2_runtime_boundary_behavior(self):
        controller = _fake_controller()
        manager = Provisioner(controller)

        provisioned = {
            "private_host": "10.0.0.30",
            "public_host": "54.10.20.30",
            "runtime_id": "canyonos-remote-0--i-test1",
            "redis_port": 6390,
        }
        instance = {
            "agent_name": "Remote",
            "provider": "EC2",
            "replica_index": "0",
            "private_host": "10.0.0.30",
            "public_host": "54.10.20.30",
            "host_port": "50051",
            "container_port": "50051",
            "endpoint": "10.0.0.30:50051",
            "routing_endpoint": "10.0.0.30:50051",
            "redis_host": "10.0.0.30",
            "redis_port": "6390",
            "runtime_id": "canyonos-remote-0--i-test1",
        }

        runtime = _fake_runtime(
            hourly_cost=MagicMock(return_value=0.0208),
            provision_instance=MagicMock(return_value=provisioned),
            bootstrap_instance=MagicMock(return_value=instance),
        )

        with patch("canyonos_core.reconciler.providers.get", return_value=runtime):
            created = manager.ensure_instances(
                [
                    {
                        "name": "Remote",
                        "provider": "EC2",
                        "instance_type": "t3.small",
                        "redis_port": 6390,
                    }
                ]
            )[0]
            self.assertEqual(
                controller.redis.get("agent:Remote-0:hourly_cost"), "0.0208"
            )
            controller.node_redis = {"10.0.0.30": _FakeRedis()}
            controller.redis_containers = {"10.0.0.30": "redis-box"}
            manager.remove_instance("EC2:Remote:0")

        runtime.provision_instance.assert_called_once()
        provision_args = runtime.provision_instance.call_args.args
        self.assertEqual(
            provision_args[:2],
            (
                {
                    "name": "Remote",
                    "provider": "EC2",
                    "instance_type": "t3.small",
                    "redis_port": 6390,
                },
                0,
            ),
        )
        # EC2 jobs never get a pre-claimed port, so this must resolve to None.
        self.assertIsNone(provision_args[2]("10.0.0.30"))
        runtime.bootstrap_instance.assert_called_once_with(
            provisioned,
            {
                "name": "Remote",
                "provider": "EC2",
                "instance_type": "t3.small",
                "redis_port": 6390,
            },
            0,
            ANY,
        )
        # The saved record also has launch_id, launched_at, and created_at.
        runtime.terminate_instance.assert_called_once_with(
            {**instance, "launch_id": ANY, "launched_at": ANY, "created_at": ANY}
        )
        self.assertEqual(created, instance)

    def test_manager_uses_same_runtime_contract_for_local_and_ec2(self):
        controller = _fake_controller()
        manager = Provisioner(controller)

        local_instance = {
            "agent_name": "Local",
            "provider": "local",
            "replica_index": "0",
            "private_host": "localhost",
            "public_host": "localhost",
            "host_port": "8000",
            "container_port": "50051",
            "endpoint": "localhost:8000",
            "routing_endpoint": "canyonos-local-0:50051",
            "redis_host": "host.docker.internal",
            "redis_port": "6379",
            "runtime_id": "canyonos-local-0",
        }
        ec2_instance = {
            "agent_name": "Remote",
            "provider": "EC2",
            "replica_index": "0",
            "private_host": "10.0.0.30",
            "public_host": "54.10.20.30",
            "host_port": "50051",
            "container_port": "50051",
            "endpoint": "10.0.0.30:50051",
            "routing_endpoint": "10.0.0.30:50051",
            "redis_host": "10.0.0.30",
            "redis_port": "6379",
            "runtime_id": "canyonos-remote-0--i-test1",
        }

        local_runtime = _fake_runtime(
            port_claim_host=MagicMock(return_value="localhost"),
            provision_instance=MagicMock(
                return_value={"runtime_id": "canyonos-local-0"}
            ),
            bootstrap_instance=MagicMock(return_value=local_instance),
        )
        ec2_runtime = _fake_runtime(
            provision_instance=MagicMock(
                return_value={"runtime_id": "canyonos-remote-0--i-test1"}
            ),
            bootstrap_instance=MagicMock(return_value=ec2_instance),
        )

        def runtime_for(provider):
            return ec2_runtime if provider == "EC2" else local_runtime

        with patch("canyonos_core.reconciler.providers.get", side_effect=runtime_for):
            manager.ensure_instances(
                [
                    {"name": "Local", "provider": "local"},
                    {"name": "Remote", "provider": "EC2", "instance_type": "t3.small"},
                ]
            )

        local_runtime.provision_instance.assert_called_once()
        local_provision_args = local_runtime.provision_instance.call_args.args
        self.assertEqual(
            local_provision_args[:2], ({"name": "Local", "provider": "local"}, 0)
        )
        # Local jobs get a pre-claimed port (8000 is the first free port).
        self.assertEqual(local_provision_args[2]("localhost"), 8000)
        local_runtime.bootstrap_instance.assert_called_once_with(
            {"runtime_id": "canyonos-local-0"},
            {"name": "Local", "provider": "local"},
            0,
            ANY,
        )
        ec2_runtime.provision_instance.assert_called_once()
        ec2_provision_args = ec2_runtime.provision_instance.call_args.args
        self.assertEqual(
            ec2_provision_args[:2],
            ({"name": "Remote", "provider": "EC2", "instance_type": "t3.small"}, 0),
        )
        self.assertIsNone(ec2_provision_args[2]("10.0.0.30"))
        ec2_runtime.bootstrap_instance.assert_called_once_with(
            {"runtime_id": "canyonos-remote-0--i-test1"},
            {"name": "Remote", "provider": "EC2", "instance_type": "t3.small"},
            0,
            ANY,
        )


class PortClaimTests(unittest.TestCase):
    def _claim(self, redis, replica_index, port):
        redis.hset_multiple(
            f"agent_instance:local:Alpha:{replica_index}",
            {
                "agent_name": "Alpha",
                "provider": "local",
                "replica_index": str(replica_index),
                "private_host": "localhost",
                "host_port": str(port),
            },
        )

    def test_a_port_claim_is_hidden_from_full_instance_scans(self):
        controller = _fake_controller()
        self._claim(controller.redis, 0, 8000)

        self.assertEqual(list_instances(controller.redis), [])

    def test_a_port_claim_still_blocks_its_port_for_the_next_replica(self):
        controller = _fake_controller()
        self._claim(controller.redis, 0, 8000)
        manager = Provisioner(controller)

        port = manager._claim_host_port("localhost", "agent_instance:local:Alpha:1")

        self.assertEqual(port, 8001)

    def test_a_port_claim_left_by_an_earlier_pass_is_removed(self):
        controller = _fake_controller()
        self._claim(controller.redis, 3, 8003)
        runtime = _fake_runtime()
        manager = Provisioner(controller)

        with patch("canyonos_core.reconciler.providers.get", return_value=runtime):
            manager.remove_unfinished()

        self.assertEqual(controller.redis.hgetall("agent_instance:local:Alpha:3"), {})
        runtime.terminate_instance.assert_called_once()

    def test_a_failed_launch_leaves_its_record_for_remove_unfinished(self):
        """One cleanup path covers a launch that raised and one whose process died."""
        controller = _fake_controller()
        self._claim(controller.redis, 0, 8000)
        runtime = _fake_runtime(
            provision_instance=MagicMock(
                return_value={"runtime_id": "canyonos-alpha-0--i-1"}
            ),
            bootstrap_instance=MagicMock(side_effect=RuntimeError("boom")),
        )
        manager = Provisioner(controller)

        with self.assertRaisesRegex(RuntimeError, "boom"):
            manager._provision_one(
                {
                    "agent_name": "Alpha",
                    "agent_spec": {"name": "Alpha"},
                    "runtime": runtime,
                    "replica_index": 0,
                    "instance_id": "local:Alpha:0",
                    "claimed_port": 8000,
                    "launch_id": "launch-1",
                }
            )

        record = controller.redis.hgetall("agent_instance:local:Alpha:0")
        self.assertEqual(record["runtime_id"], "canyonos-alpha-0--i-1")
        runtime.terminate_instance.assert_not_called()


ENDPOINT_SPEC = {
    "name": "endpoint",
    "type": "endpoint",
    "replicas": 1,
    "redis_port": 6379,
    "host_port": 50051,
    "resources": {"cpu": 2},
    "api_port": 9090,
    "agent": "Workflow",
    "method": "main",
}


if __name__ == "__main__":
    unittest.main()


class ControllerStatusKeyTests(unittest.TestCase):
    STATUS_KEY = "controller:canyonos-alpha-0:50051:status"

    def test_launch_clears_the_status_the_last_container_at_this_endpoint_left(self):
        """The key has no TTL and the endpoint is the container name, so a
        previous run's "healthy" would pass for the new container's."""
        controller = _fake_controller()
        controller.redis.set(self.STATUS_KEY, "healthy")
        manager = Provisioner(controller)

        manager.ensure_instances([{"name": "Alpha", "provider": "local"}])

        self.assertNotIn(self.STATUS_KEY, controller.redis.strings)

    def test_launch_clears_the_status_right_before_docker_run(self):
        controller = _fake_controller()
        controller.redis.set(self.STATUS_KEY, "healthy")
        seen_at_run = []
        run_cmd = controller._run_cmd.side_effect

        def observe(cmd, host, user=None):
            if cmd[:2] == ["docker", "run"]:
                seen_at_run.append(controller.redis.get(self.STATUS_KEY))
            return run_cmd(cmd, host, user)

        controller._run_cmd = observe
        manager = Provisioner(controller)

        manager.ensure_instances([{"name": "Alpha", "provider": "local"}])

        self.assertEqual(seen_at_run, [None])

    def test_a_launch_that_cannot_clear_the_status_does_not_proceed(self):
        controller = _fake_controller()

        def refuse(*_keys):
            raise ConnectionError("redis away")

        controller.redis.delete = refuse
        manager = Provisioner(controller)

        with self.assertRaisesRegex(RuntimeError, "could not clear the stale"):
            manager.ensure_instances([{"name": "Alpha", "provider": "local"}])

        commands = [call.args[0][:2] for call in controller._run_cmd.call_args_list]
        self.assertNotIn(["docker", "run"], commands)

    def test_remove_instance_deletes_the_status_before_destroying_the_runtime(self):
        controller = _fake_controller()
        manager = Provisioner(controller)
        manager.ensure_instances([{"name": "Alpha", "provider": "local"}])
        controller.redis.set(self.STATUS_KEY, "healthy")
        seen_at_rm = []
        run_cmd = controller._run_cmd.side_effect

        def observe(cmd, host, user=None):
            if cmd[:3] == ["docker", "rm", "-f"]:
                seen_at_rm.append(controller.redis.get(self.STATUS_KEY))
            return run_cmd(cmd, host, user)

        controller._run_cmd = observe

        manager.remove_instance("local:Alpha:0")

        self.assertEqual(seen_at_rm, [None])
        self.assertNotIn(self.STATUS_KEY, controller.redis.strings)

    def test_a_status_that_cannot_be_deleted_does_not_stop_the_teardown(self):
        controller = _fake_controller()
        manager = Provisioner(controller)
        manager.ensure_instances([{"name": "Alpha", "provider": "local"}])
        delete = controller.redis.delete

        def refuse_status(*keys):
            if any(key.endswith(":status") for key in keys):
                raise ConnectionError("redis away")
            delete(*keys)

        controller.redis.delete = refuse_status

        with self.assertLogs("canyonos_core.reconciler.provisioner", level="WARNING"):
            manager.remove_instance("local:Alpha:0")

        self.assertEqual(controller.redis.hgetall("agent_instance:local:Alpha:0"), {})
