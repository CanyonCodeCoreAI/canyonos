import os
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import ANY, MagicMock, patch

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from canyonos_core.reconciler.providers.Local import (
    _runtime as local_runtime,
)
from canyonos_core.controller.controller_context import list_instances
from canyonos_core.reconciler.provisioner import Provisioner
from fakes import _FakeRedis


def _fake_controller():
    redis = _FakeRedis()
    running = set()

    def fake_run_cmd(cmd, host, user=None):
        if cmd[:2] == ["docker", "inspect"]:
            return SimpleNamespace(
                returncode=0 if cmd[-1] in running else 1,
                stdout="true\n" if cmd[-1] in running else "",
            )
        if cmd[:2] == ["docker", "run"]:
            running.add(cmd[cmd.index("--name") + 1])
        elif cmd[:3] == ["docker", "rm", "-f"]:
            running.discard(cmd[-1])
        return SimpleNamespace(returncode=0, stdout="")

    return SimpleNamespace(
        redis=redis,
        containers={},
        node_redis={},
        redis_containers={},
        redis_ports={},
        config={"poll_interval": 5},
        _run_cmd=MagicMock(side_effect=fake_run_cmd),
    )


def _fake_runtime(**kwargs):
    runtime = SimpleNamespace(
        validate_config=MagicMock(),
        provision_instance=MagicMock(return_value={}),
        bootstrap_instance=MagicMock(return_value={}),
        terminate_instance=MagicMock(),
        routing_endpoint_for=MagicMock(
            side_effect=lambda instance: instance["endpoint"]
        ),
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
                return SimpleNamespace(returncode=0, stdout="true\n")
            return SimpleNamespace(returncode=0, stdout="")

        controller._run_cmd = fake_run_cmd
        manager = Provisioner(controller)

        manager.ensure_instances([{"name": "Alpha", "provider": "local"}])

        self.assertEqual(
            [c[:3] for c in calls],
            [
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

        alpha_agent_id = alpha.pop("agent_id")
        self.assertEqual(len(alpha_agent_id), 32)
        int(alpha_agent_id, 16)  # raises ValueError if not a hex string

        self.assertEqual(
            alpha,
            {
                "agent_name": "Alpha",
                "provider": "local",
                "replica_index": "0",
                "host": "localhost",
                "host_port": "8000",
                "container_port": "50051",
                "endpoint": "localhost:8000",
                "redis_host": "canyonos-redis-localhost",
                "redis_port": "6379",
                "runtime_id": "canyonos-alpha-0",
            },
        )

        self.assertEqual(beta["host"], "localhost")
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
                    "-e",
                    "CANYONOS_LLM_STUB_TEXT=",
                    "canyonos-alpha",
                ],
                "localhost",
                None,
            ),
        )

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

    def test_local_provider_case_is_normalized_before_claiming_a_port(self):
        controller = _fake_controller()
        manager = Provisioner(controller)

        instance = manager.ensure_instances([{"name": "Alpha", "provider": "LOCAL"}])[0]

        self.assertEqual(instance["provider"], "local")
        self.assertEqual(instance["host_port"], "8000")

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

    def test_llm_stub_env_is_forwarded_to_the_agent_when_set(self):
        controller = _fake_controller()
        manager = Provisioner(controller)

        with patch.dict(os.environ, {"CANYONOS_LLM_STUB_TEXT": "test"}):
            manager.ensure_instances([{"name": "Alpha", "provider": "local"}])

        cmd = controller._run_cmd.call_args_list[1].args[0]
        self.assertIn("CANYONOS_LLM_STUB_TEXT=test", cmd)

    def test_llm_stub_is_explicitly_disabled_by_default(self):
        """Without `canyonos test`, the stub is pinned empty (off) and immune to --env-file."""
        controller = _fake_controller()
        manager = Provisioner(controller)

        os.environ.pop("CANYONOS_LLM_STUB_TEXT", None)
        manager.ensure_instances([{"name": "Alpha", "provider": "local"}])

        cmd = controller._run_cmd.call_args_list[1].args[0]
        # Explicitly empty means stub off; -e beats --env-file, so a user's .env loses.
        self.assertIn("CANYONOS_LLM_STUB_TEXT=", cmd)
        self.assertNotIn("CANYONOS_LLM_STUB_TEXT=test", cmd)

    def test_local_workflow_and_resource_flags_stay_the_same(self):
        controller = _fake_controller()
        manager = Provisioner(controller)

        with patch.object(local_runtime, "_port_check", return_value=False):
            manager.ensure_instances(
                [
                    {
                        "name": "Workflow",
                        "provider": "local",
                        "type": "workflow",
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
                    "-e",
                    "CANYONOS_LLM_STUB_TEXT=",
                    "-p",
                    "8080:8080",
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

    def test_workflow_bootstrap_fails_fast_on_an_occupied_api_port(self):
        controller = _fake_controller()
        manager = Provisioner(controller)

        with patch.object(local_runtime, "_port_check", return_value=True):
            with self.assertRaises(RuntimeError) as ctx:
                manager.ensure_instances(
                    [{"name": "Workflow", "provider": "local", "type": "workflow"}]
                )

        self.assertIn("api_port 8080", str(ctx.exception))
        # The orphan-container `docker inspect` probe still runs -- only `docker run` is skipped.
        run_calls = [
            c
            for c in controller._run_cmd.call_args_list
            if c.args[0][:2] == ["docker", "run"]
        ]
        self.assertEqual(run_calls, [])

    def test_plain_agent_bootstrap_ignores_api_port_conflicts(self):
        """Only `type: workflow` publishes api_port -- a plain agent has nothing to conflict on."""
        controller = _fake_controller()
        manager = Provisioner(controller)

        with patch.object(local_runtime, "_port_check", return_value=True):
            manager.ensure_instances([{"name": "Alpha", "provider": "local"}])

        controller._run_cmd.assert_called()

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

    def test_instance_record_failure_removes_the_new_local_runtime(self):
        controller = _fake_controller()
        manager = Provisioner(controller)
        write = controller.redis.hset_multiple

        def fail_instance_record(name, mapping):
            if "runtime_id" in mapping:
                raise RuntimeError("redis unavailable")
            write(name, mapping)

        controller.redis.hset_multiple = fail_instance_record

        with self.assertRaisesRegex(RuntimeError, "redis unavailable"):
            manager.ensure_instances([{"name": "Alpha", "provider": "local"}])

        commands = [call.args[0] for call in controller._run_cmd.call_args_list]
        self.assertIn(["docker", "rm", "-f", "canyonos-alpha-0"], commands)
        self.assertEqual(controller.containers["Alpha"], [])

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

    def test_missing_runtime_behind_stale_record_is_reprovisioned(self):
        controller = _fake_controller()
        manager = Provisioner(controller)
        key = "agent_instance:local:Alpha:0"
        stale = {
            "agent_id": "stale-agent-id",
            "agent_name": "Alpha",
            "provider": "local",
            "replica_index": "0",
            "host": "localhost",
            "host_port": "8000",
            "container_port": "50051",
            "endpoint": "localhost:8000",
            "redis_host": "canyonos-redis-localhost",
            "redis_port": "6379",
            "runtime_id": "canyonos-alpha-0",
        }
        controller.redis.hset_multiple(key, stale)
        controller.redis.sadd("agent:Alpha:instances", "local:Alpha:0")

        instance = manager.ensure_instances([{"name": "Alpha", "provider": "local"}])[0]

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
        self.assertEqual(controller.containers["Alpha"], [])

    def test_manager_keeps_ec2_runtime_boundary_behavior(self):
        controller = _fake_controller()
        manager = Provisioner(controller)

        provisioned = {
            "host": "10.0.0.30",
            "runtime_id": "canyonos-remote-0--i-test1",
            "redis_port": 6390,
        }
        instance = {
            "agent_name": "Remote",
            "provider": "EC2",
            "replica_index": "0",
            "host": "10.0.0.30",
            "host_port": "50051",
            "container_port": "50051",
            "endpoint": "10.0.0.30:50051",
            "redis_host": "10.0.0.30",
            "redis_port": "6390",
            "runtime_id": "canyonos-remote-0--i-test1",
        }

        runtime = _fake_runtime(
            provision_instance=MagicMock(return_value=provisioned),
            bootstrap_instance=MagicMock(return_value=instance),
        )
        del runtime.validate_config

        with patch.object(manager, "_provider_runtime", return_value=runtime):
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
        # The record read back from Redis carries the creation timestamp
        # _write_instance stamps on it.
        runtime.terminate_instance.assert_called_once_with(
            {**instance, "created_at": ANY}
        )
        self.assertEqual(created, instance)

    def test_manager_uses_same_runtime_contract_for_local_and_ec2(self):
        controller = _fake_controller()
        manager = Provisioner(controller)

        local_instance = {
            "agent_name": "Local",
            "provider": "local",
            "replica_index": "0",
            "host": "localhost",
            "host_port": "8000",
            "container_port": "50051",
            "endpoint": "localhost:8000",
            "redis_host": "host.docker.internal",
            "redis_port": "6379",
            "runtime_id": "canyonos-local-0",
        }
        ec2_instance = {
            "agent_name": "Remote",
            "provider": "EC2",
            "replica_index": "0",
            "host": "10.0.0.30",
            "host_port": "50051",
            "container_port": "50051",
            "endpoint": "10.0.0.30:50051",
            "redis_host": "10.0.0.30",
            "redis_port": "6379",
            "runtime_id": "canyonos-remote-0--i-test1",
        }

        local_runtime = _fake_runtime(
            bootstrap_instance=MagicMock(return_value=local_instance),
            routing_endpoint_for=MagicMock(return_value="host.docker.internal:8000"),
        )
        ec2_runtime = _fake_runtime(
            bootstrap_instance=MagicMock(return_value=ec2_instance),
            routing_endpoint_for=MagicMock(return_value="10.0.0.30:50051"),
        )
        del ec2_runtime.validate_config

        def runtime_for(provider):
            return ec2_runtime if provider == "EC2" else local_runtime

        with patch.object(manager, "_provider_runtime", side_effect=runtime_for):
            manager.ensure_instances(
                [
                    {"name": "Local", "provider": "local"},
                    {"name": "Remote", "provider": "EC2", "instance_type": "t3.small"},
                ]
            )

        local_runtime.validate_config.assert_called_once_with()
        local_runtime.provision_instance.assert_called_once()
        local_provision_args = local_runtime.provision_instance.call_args.args
        self.assertEqual(
            local_provision_args[:2], ({"name": "Local", "provider": "local"}, 0)
        )
        # Local jobs get a pre-claimed port (8000 is the first free port).
        self.assertEqual(local_provision_args[2]("localhost"), 8000)
        local_runtime.bootstrap_instance.assert_called_once_with(
            {}, {"name": "Local", "provider": "local"}, 0, ANY
        )
        ec2_runtime.provision_instance.assert_called_once()
        ec2_provision_args = ec2_runtime.provision_instance.call_args.args
        self.assertEqual(
            ec2_provision_args[:2],
            ({"name": "Remote", "provider": "EC2", "instance_type": "t3.small"}, 0),
        )
        self.assertIsNone(ec2_provision_args[2]("10.0.0.30"))
        ec2_runtime.bootstrap_instance.assert_called_once_with(
            {},
            {"name": "Remote", "provider": "EC2", "instance_type": "t3.small"},
            0,
            ANY,
        )

    def test_local_provider_runtime_does_not_require_ec2_import(self):
        controller = _fake_controller()
        manager = Provisioner(controller)

        runtime = manager._provider_runtime("local")

        self.assertIs(runtime, local_runtime)


class PortClaimTests(unittest.TestCase):
    def _claim(self, redis, replica_index, port):
        redis.hset_multiple(
            f"agent_instance:local:Alpha:{replica_index}",
            {
                "agent_name": "Alpha",
                "provider": "local",
                "replica_index": str(replica_index),
                "host": "localhost",
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

        port = manager._claim_host_port(
            "localhost", "agent_instance:local:Alpha:1", "Alpha", "local", 1
        )

        self.assertEqual(port, 8001)

    def test_a_port_claim_for_a_slot_no_agent_wants_is_pruned(self):
        controller = _fake_controller()
        self._claim(controller.redis, 3, 8003)
        manager = Provisioner(controller)
        manager._agent_specs = [{"name": "Alpha", "provider": "local", "replicas": 1}]

        manager._prune_stale_port_claims()

        self.assertEqual(controller.redis.hgetall("agent_instance:local:Alpha:3"), {})

    def test_a_port_claim_for_a_wanted_slot_is_kept(self):
        controller = _fake_controller()
        self._claim(controller.redis, 0, 8000)
        manager = Provisioner(controller)
        manager._agent_specs = [{"name": "Alpha", "provider": "local", "replicas": 1}]

        manager._prune_stale_port_claims()

        self.assertEqual(
            controller.redis.hgetall("agent_instance:local:Alpha:0")["host_port"],
            "8000",
        )

    def test_a_failed_provision_removes_its_port_claim(self):
        controller = _fake_controller()
        self._claim(controller.redis, 0, 8000)
        runtime = _fake_runtime(
            provision_instance=MagicMock(side_effect=RuntimeError("boom"))
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
                }
            )

        self.assertEqual(controller.redis.hgetall("agent_instance:local:Alpha:0"), {})
        runtime.terminate_instance.assert_not_called()


if __name__ == "__main__":
    unittest.main()
