# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

import os
import subprocess
import sys
import time
import unittest
from types import SimpleNamespace
from unittest.mock import ANY, MagicMock, patch

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from canyonos_core.reconciler import replicas
from canyonos_core.controller.controller_context import (
    list_replicas,
)
from canyonos_core.reconciler.provisioner import DRAIN_TIMEOUT_SECONDS, Provisioner
from fakes import _fake_controller, _replica


def _fake_provider(**kwargs):
    provider = SimpleNamespace(
        hourly_cost=MagicMock(return_value=0),
        start_machine=MagicMock(
            return_value={"private_host": "localhost", "public_host": "localhost"}
        ),
        wait_for_machine=MagicMock(return_value={}),
        terminate_machine=MagicMock(return_value=None),
        _controller=None,
    )
    for key, value in kwargs.items():
        setattr(provider, key, value)
    return provider


class ProvisionerTests(unittest.TestCase):
    def test_launch_removes_an_orphaned_running_container_before_recreating(
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

        manager.ensure_replicas([{"name": "Alpha", "provider": "local"}])

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
        controller.redis_ports["localhost"] = 9002
        manager = Provisioner(controller)

        replica = manager.ensure_replicas([{"name": "Alpha", "provider": "local"}])[0]

        self.assertEqual(replica["redis_port"], "9002")
        run_argv = controller._run_cmd.call_args_list[1].args[0]
        self.assertIn("CANYONOS_REDIS_PORT=9002", run_argv)

    def test_local_replicas_keep_default_host_and_increment_host_ports(self):
        controller = _fake_controller()
        manager = Provisioner(controller)

        alpha = manager.ensure_replicas([{"name": "Alpha", "provider": "local"}])[0]
        beta = manager.ensure_replicas([{"name": "Beta", "provider": "local"}])[0]

        self.assertEqual(
            alpha,
            {
                "agent_name": "Alpha",
                "provider": "local",
                "replica_index": "0",
                "private_host": "localhost",
                "public_host": "localhost",
                "host_port": "50051",
                "container_port": "50051",
                "published_address": "localhost:50051",
                "address": "canyonos-alpha-0:50051",
                "redis_host": "canyonos-redis-localhost",
                "redis_port": "6379",
                "container_name": "canyonos-alpha-0",
            },
        )

        self.assertEqual(beta["private_host"], "localhost")
        self.assertEqual(beta["host_port"], "50052")
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
                    "50051:50051",
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
                    "HTTP_PROXY=http://127.0.0.1:8082",
                    "-e",
                    "HTTPS_PROXY=http://127.0.0.1:8082",
                    "-e",
                    "NO_PROXY=127.0.0.1,localhost,169.254.169.254,169.254.170.2",
                    "-e",
                    "SSL_CERT_FILE=/tmp/canyonos-proxy/ca-bundle.pem",
                    "-e",
                    "REQUESTS_CA_BUNDLE=/tmp/canyonos-proxy/ca-bundle.pem",
                    "-e",
                    "AWS_CA_BUNDLE=/tmp/canyonos-proxy/ca-bundle.pem",
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

    def test_a_local_database_is_routed_on_its_container_port(self):
        controller = _fake_controller()
        manager = Provisioner(controller)

        with patch.object(replicas, "_port_bound", return_value=False):
            replica = manager.ensure_replicas(
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
        self.assertEqual(replica["host_port"], "5433")
        self.assertEqual(replica["address"], "canyonos-pg-0:5432")

    def test_only_limits_which_agents_get_replicas_but_routing_keeps_every_agent(self):
        controller = _fake_controller()
        manager = Provisioner(controller)

        manager.ensure_replicas(
            [
                {"name": "Alpha", "provider": "local"},
                {"name": "Beta", "provider": "local"},
            ],
            only={"Alpha"},
        )

        self.assertEqual(
            [replica["agent_name"] for replica in list_replicas(controller.redis)],
            ["Alpha"],
        )
        self.assertEqual(
            controller.redis.smembers("routing_table:agents"), {"Alpha", "Beta"}
        )

    def test_launch_passes_poll_interval_env_var(self):
        controller = _fake_controller()
        controller.config = {"poll_interval": 7}
        manager = Provisioner(controller)

        manager.ensure_replicas([{"name": "Alpha", "provider": "local"}])

        cmd = controller._run_cmd.call_args.args[0]
        self.assertIn("CANYONOS_POLL_INTERVAL=7", cmd)

    def test_local_bootstrap_passes_logs_enabled_env_var_with_its_flag(self):
        """CANYONOS_LOGS_ENABLED must be preceded by its own '-e' -- a bare
        'KEY=value' string with no flag is treated by `docker run` as the IMAGE
        positional argument, breaking the launch entirely."""
        controller = _fake_controller()
        controller.config = {"logs": True}
        manager = Provisioner(controller)

        manager.ensure_replicas([{"name": "Alpha", "provider": "local"}])

        cmd = controller._run_cmd.call_args.args[0]
        index = cmd.index("CANYONOS_LOGS_ENABLED=true")
        self.assertEqual(cmd[index - 1], "-e")

    def test_local_bootstrap_defaults_logs_enabled_to_true(self):
        controller = _fake_controller()
        controller.config = {}
        manager = Provisioner(controller)

        manager.ensure_replicas([{"name": "Alpha", "provider": "local"}])

        cmd = controller._run_cmd.call_args.args[0]
        index = cmd.index("CANYONOS_LOGS_ENABLED=true")
        self.assertEqual(cmd[index - 1], "-e")

    def test_local_bootstrap_honors_explicit_logs_false(self):
        controller = _fake_controller()
        controller.config = {"logs": False}
        manager = Provisioner(controller)

        manager.ensure_replicas([{"name": "Alpha", "provider": "local"}])

        cmd = controller._run_cmd.call_args.args[0]
        index = cmd.index("CANYONOS_LOGS_ENABLED=false")
        self.assertEqual(cmd[index - 1], "-e")

    def test_local_agent_and_resource_flags_stay_the_same(self):
        controller = _fake_controller()
        manager = Provisioner(controller)

        manager.ensure_replicas(
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
                    "50051:50051",
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
                    "HTTP_PROXY=http://127.0.0.1:8082",
                    "-e",
                    "HTTPS_PROXY=http://127.0.0.1:8082",
                    "-e",
                    "NO_PROXY=127.0.0.1,localhost,169.254.169.254,169.254.170.2",
                    "-e",
                    "SSL_CERT_FILE=/tmp/canyonos-proxy/ca-bundle.pem",
                    "-e",
                    "REQUESTS_CA_BUNDLE=/tmp/canyonos-proxy/ca-bundle.pem",
                    "-e",
                    "AWS_CA_BUNDLE=/tmp/canyonos-proxy/ca-bundle.pem",
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

    def test_replica_id_is_published_under_the_controller_address_key(self):
        controller = _fake_controller()
        manager = Provisioner(controller)

        manager.ensure_replicas([{"name": "Alpha", "provider": "local"}])

        self.assertEqual(
            controller.redis.get("controller:canyonos-alpha-0:50051:replica_id"),
            "Alpha-0",
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
            manager.ensure_replicas(
                [
                    {"name": "Alpha", "provider": "local"},
                    {"name": "Beta", "provider": "local"},
                ]
            )

        self.assertEqual(
            controller.redis.smembers("agent:Alpha:instances"), {"Alpha-0"}
        )
        publish.assert_called_once()
        self.assertIn("Failed to provision Beta-0", "\n".join(logs.output))

    def test_missing_container_behind_stale_record_is_reprovisioned(self):
        controller = _fake_controller()
        manager = Provisioner(controller)
        key = "agent_instance:Alpha-0"
        stale = {
            "agent_name": "Alpha",
            "provider": "local",
            "replica_index": "0",
            "private_host": "localhost",
            "public_host": "localhost",
            "host_port": "8000",
            "container_port": "50051",
            "published_address": "localhost:8000",
            "address": "canyonos-alpha-0:50051",
            "redis_host": "canyonos-redis-localhost",
            "redis_port": "6379",
            "container_name": "canyonos-alpha-0",
        }
        controller.redis.hset_multiple(key, stale)
        controller.redis.sadd("agent:Alpha:instances", "Alpha-0")

        with self.assertLogs("canyonos_core.reconciler.provisioner", "WARNING") as logs:
            manager.ensure_replicas([{"name": "Alpha", "provider": "local"}])

        self.assertIn("Replacing Alpha-0", logs.output[0])
        commands = [call.args[0] for call in controller._run_cmd.call_args_list]
        self.assertTrue(
            any(command[:3] == ["docker", "run", "-d"] for command in commands)
        )
        self.assertEqual(
            controller.redis.smembers("agent:Alpha:instances"), {"Alpha-0"}
        )

    def test_a_replica_on_an_unreachable_machine_keeps_its_slot_and_blocks_nothing_else(
        self,
    ):
        controller = _fake_controller()
        reachable = controller._run_cmd.side_effect

        def run_cmd(cmd, host, user=None):
            if host == "10.0.0.9":
                return subprocess.CompletedProcess(cmd, 255, "", "No route to host")
            return reachable(cmd, host, user)

        controller._run_cmd.side_effect = run_cmd
        stale = {**_replica("Alpha", 0), "provider": "EC2", "private_host": "10.0.0.9"}
        controller.redis.hset_multiple("agent_instance:Alpha-0", stale)

        with self.assertLogs("canyonos_core.reconciler.provisioner", "WARNING"):
            Provisioner(controller).ensure_replicas(
                [
                    {"name": "Alpha", "provider": "EC2"},
                    {"name": "Beta", "provider": "local"},
                ]
            )

        self.assertEqual(controller.redis.hgetall("agent_instance:Alpha-0"), stale)
        self.assertIn("address", controller.redis.hgetall("agent_instance:Beta-0"))

    def test_local_remove_replica_still_removes_the_same_container(self):
        controller = _fake_controller()
        manager = Provisioner(controller)
        manager.ensure_replicas([{"name": "Alpha", "provider": "local"}])

        controller._run_cmd.reset_mock()
        manager.remove_replica("Alpha-0", drain=False)

        self.assertEqual(
            controller._run_cmd.call_args.args,
            (["docker", "rm", "-f", "canyonos-alpha-0"], "localhost", None),
        )
        self.assertEqual(controller.redis.hgetall("agent_instance:Alpha-0"), {})

    def test_another_machine_gets_its_redis_before_the_container(self):
        controller = _fake_controller()
        manager = Provisioner(controller)
        spec = {"name": "Remote", "provider": "EC2", "machine_type": "t3.small"}
        provider = _fake_provider(
            hourly_cost=MagicMock(return_value=0.0208),
            start_machine=MagicMock(return_value={"machine_id": "i-test1"}),
            wait_for_machine=MagicMock(
                return_value={
                    "private_host": "10.0.0.30",
                    "public_host": "54.10.20.30",
                    "user": "ubuntu",
                }
            ),
        )

        with (
            patch("canyonos_core.reconciler.providers.get", return_value=provider),
            patch.object(replicas, "transfer_image"),
        ):
            created = manager.ensure_replicas([spec])[0]

        provider.hourly_cost.assert_called_once_with({"machine_type": "t3.small"})
        provider.start_machine.assert_called_once_with(
            {"machine_type": "t3.small"}, ANY
        )
        runs = [
            call.args
            for call in controller._run_cmd.call_args_list
            if call.args[0][:2] == ["docker", "run"]
        ]
        self.assertEqual(
            [args[0][args[0].index("--name") + 1] for args in runs],
            ["canyonos-redis-10-0-0-30", "canyonos-remote-0"],
        )
        self.assertEqual({args[1:] for args in runs}, {("10.0.0.30", "ubuntu")})
        self.assertEqual(
            created,
            {
                "agent_name": "Remote",
                "provider": "EC2",
                "replica_index": "0",
                "private_host": "10.0.0.30",
                "public_host": "54.10.20.30",
                "host_port": "50051",
                "container_port": "50051",
                "published_address": "10.0.0.30:50051",
                "address": "10.0.0.30:50051",
                "redis_host": "host.docker.internal",
                "redis_port": "6379",
                "container_name": "canyonos-remote-0",
                "user": "ubuntu",
            },
        )
        record = controller.redis.hgetall("agent_instance:Remote-0")
        machine = controller.redis.hgetall(f"machine_record:{record['launch_id']}")
        self.assertNotIn("machine_id", record)
        self.assertEqual(
            {key: machine[key] for key in ("provider", "machine_id", "private_host")},
            {"provider": "EC2", "machine_id": "i-test1", "private_host": "10.0.0.30"},
        )
        self.assertEqual(controller.redis.get("agent:Remote-0:hourly_cost"), "0.0208")

    def test_removing_a_replica_leaves_its_machine_running(self):
        controller = _fake_controller()
        provider = _fake_provider(
            start_machine=MagicMock(return_value={"machine_id": "i-1"}),
            wait_for_machine=MagicMock(
                return_value={"private_host": "10.0.0.30", "public_host": "54.1.2.3"}
            ),
        )
        manager = Provisioner(controller)
        with (
            patch("canyonos_core.reconciler.providers.get", return_value=provider),
            patch.object(replicas, "transfer_image"),
        ):
            manager.ensure_replicas([{"name": "Remote", "provider": "EC2"}])
            controller._run_cmd.reset_mock()

            self.assertTrue(manager.remove_replica("Remote-0", drain=False))

        self.assertEqual(
            controller._run_cmd.call_args.args[0],
            ["docker", "rm", "-f", "canyonos-remote-0"],
        )
        provider.terminate_machine.assert_not_called()
        self.assertEqual(len(controller.redis.scan_keys("machine_record:*")), 1)


class DrainTests(unittest.TestCase):
    def setUp(self):
        self.controller = _fake_controller()
        self.redis = self.controller.redis
        self.manager = Provisioner(self.controller)
        self.manager._agent_specs = []
        self.replica = _replica("Alpha", 1)
        self.key = "agent_instance:Alpha-1"
        self.redis.hset_multiple(self.key, self.replica)
        self.flag = f"controller:{self.replica['address']}:draining"
        self.metrics = f"controller:{self.replica['address']}:metrics"

    def test_drain_marks_the_record_and_tells_the_replica_to_take_no_new_work(self):
        self.assertFalse(self.manager.remove_replica("Alpha-1"))

        saved = self.redis.hgetall(self.key)
        # The flag holds the removal time, so the replica can fail leftovers before it.
        self.assertEqual(
            self.redis.get(self.flag),
            str(float(saved["draining_at"]) + DRAIN_TIMEOUT_SECONDS),
        )
        self.controller._run_cmd.assert_not_called()

    def test_drain_removes_the_container_once_the_replica_reports_idle(self):
        self.redis.hset_multiple(
            self.metrics,
            {
                "draining": "1",
                "queue_length": "0",
                "open_requests": "0",
                "pending_requests": "0",
                "requests_served": "5",
                "requests_completed": "5",
            },
        )

        self.assertTrue(self.manager.remove_replica("Alpha-1"))
        self.assertEqual(self.redis.hgetall(self.key), {})
        self.assertEqual(
            self.controller._run_cmd.call_args.args[0],
            ["docker", "rm", "-f", "canyonos-alpha-1"],
        )

    def test_drain_timeout_removes_a_replica_that_never_becomes_idle(self):
        started = time.time() - DRAIN_TIMEOUT_SECONDS - 1
        self.redis.hset(self.key, "draining_at", str(started))

        self.assertTrue(self.manager.remove_replica("Alpha-1"))
        self.assertEqual(self.redis.hgetall(self.key), {})

    def test_idle_needs_the_replica_to_report_draining_with_nothing_left(self):
        idle = {
            "draining": "1",
            "queue_length": "0",
            "open_requests": "0",
            "pending_requests": "0",
            "requests_served": "5",
            "requests_completed": "5",
        }
        cases = [
            ("has not seen the flag yet", {"draining": "0"}, False),
            ("work queued", {"queue_length": "1"}, False),
            ("work running", {"requests_completed": "4"}, False),
            ("a bound request still open", {"open_requests": "1"}, False),
            ("a request still to send on", {"pending_requests": "1"}, False),
            ("idle", {}, True),
        ]
        for name, change, expected in cases:
            with self.subTest(name):
                self.redis.hset_multiple(self.metrics, {**idle, **change})
                self.assertEqual(self.manager._is_idle(self.replica), expected)


class TerminateMachinesTests(unittest.TestCase):
    def setUp(self):
        self.controller = _fake_controller()
        self.redis = self.controller.redis
        for launch_id in ("l-1", "l-2"):
            self.redis.hset_multiple(
                f"machine_record:{launch_id}",
                {"provider": "EC2", "launch_id": launch_id},
            )

    def _terminate(self, provider):
        with patch("canyonos_core.reconciler.providers.get", return_value=provider):
            Provisioner(self.controller).terminate_machines()

    def test_machines_wait_until_every_replica_is_removed(self):
        self.redis.hset_multiple("agent_instance:Alpha-0", _replica("Alpha", 0))
        provider = _fake_provider()

        self._terminate(provider)

        provider.terminate_machine.assert_not_called()
        self.assertEqual(len(self.redis.scan_keys("machine_record:*")), 2)

    def test_every_machine_is_terminated_and_forgotten_once_no_replica_is_left(self):
        provider = _fake_provider()

        self._terminate(provider)

        self.assertEqual(
            sorted(
                call.args[0]["launch_id"]
                for call in provider.terminate_machine.call_args_list
            ),
            ["l-1", "l-2"],
        )
        self.assertEqual(self.redis.scan_keys("machine_record:*"), [])

    def test_a_machine_that_fails_to_terminate_keeps_its_record(self):
        def terminate(machine):
            if machine["launch_id"] == "l-1":
                raise RuntimeError("AWS does not list launch l-1 yet")

        with self.assertLogs("canyonos_core.reconciler.provisioner", "WARNING"):
            self._terminate(
                _fake_provider(terminate_machine=MagicMock(side_effect=terminate))
            )

        self.assertEqual(
            self.redis.scan_keys("machine_record:*"), ["machine_record:l-1"]
        )


class PortClaimTests(unittest.TestCase):
    def _claim(self, redis, replica_index, port):
        redis.hset_multiple(
            f"agent_instance:Alpha-{replica_index}",
            {
                "agent_name": "Alpha",
                "provider": "local",
                "replica_index": str(replica_index),
                "private_host": "localhost",
                "container_name": f"canyonos-alpha-{replica_index}",
                "host_port": str(port),
            },
        )

    def test_a_port_claim_is_hidden_from_full_replica_scans(self):
        controller = _fake_controller()
        self._claim(controller.redis, 0, 50051)

        self.assertEqual(list_replicas(controller.redis), [])

    def test_a_port_claim_still_blocks_its_port_for_the_next_replica(self):
        controller = _fake_controller()
        self._claim(controller.redis, 0, 50051)
        manager = Provisioner(controller)

        port = manager._claim_host_port("localhost", "agent_instance:Alpha-1")

        self.assertEqual(port, 50052)

    def test_a_port_claim_left_by_an_earlier_pass_is_removed(self):
        controller = _fake_controller()
        self._claim(controller.redis, 3, 50054)
        provider = _fake_provider()
        manager = Provisioner(controller)

        with patch("canyonos_core.reconciler.providers.get", return_value=provider):
            manager.remove_unfinished()

        self.assertEqual(controller.redis.hgetall("agent_instance:Alpha-3"), {})
        self.assertEqual(
            controller._run_cmd.call_args.args[0],
            ["docker", "rm", "-f", "canyonos-alpha-3"],
        )

    def test_a_failed_launch_leaves_its_record_for_remove_unfinished(self):
        """One cleanup path covers a launch that raised and one whose process died."""
        controller = _fake_controller()
        provider = _fake_provider(
            start_machine=MagicMock(return_value={"machine_id": "i-1"}),
            wait_for_machine=MagicMock(side_effect=RuntimeError("boom")),
        )
        manager = Provisioner(controller)

        with self.assertRaisesRegex(RuntimeError, "boom"):
            manager._provision_one(
                {
                    "agent_name": "Alpha",
                    "agent_spec": {"name": "Alpha"},
                    "provider": provider,
                    "machine_spec": {},
                    "replica_index": 0,
                    "replica_id": "Alpha-0",
                    "launch_id": "launch-1",
                }
            )

        self.assertEqual(
            controller.redis.hgetall("machine_record:launch-1"), {"machine_id": "i-1"}
        )
        # No container could have started, so there is none to name yet.
        self.assertNotIn(
            "container_name", controller.redis.hgetall("agent_instance:Alpha-0")
        )

        manager.remove_unfinished()

        self.assertEqual(controller.redis.hgetall("agent_instance:Alpha-0"), {})
        controller._run_cmd.assert_not_called()
        provider.terminate_machine.assert_not_called()
        self.assertEqual(
            controller.redis.hgetall("machine_record:launch-1"), {"machine_id": "i-1"}
        )


ENDPOINT_SPEC = {
    "name": "endpoint",
    "type": "endpoint",
    "replicas": 1,
    "resources": {"cpu": 2},
    "api_port": 9090,
    "agent": "Workflow",
    "method": "main",
}


if __name__ == "__main__":
    unittest.main()


class ControllerStatusKeyTests(unittest.TestCase):
    STATUS_KEY = "controller:canyonos-alpha-0:50051:status"

    def test_launch_clears_the_status_the_last_container_at_this_address_left(self):
        """The key has no TTL and the address is the container name, so a
        previous run's "healthy" would pass for the new container's."""
        controller = _fake_controller()
        controller.redis.set(self.STATUS_KEY, "healthy")
        manager = Provisioner(controller)

        manager.ensure_replicas([{"name": "Alpha", "provider": "local"}])

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

        manager.ensure_replicas([{"name": "Alpha", "provider": "local"}])

        self.assertEqual(seen_at_run, [None])

    def test_a_launch_that_cannot_clear_the_status_does_not_proceed(self):
        controller = _fake_controller()

        def refuse(*_keys):
            raise ConnectionError("redis away")

        controller.redis.delete = refuse
        manager = Provisioner(controller)

        with self.assertRaisesRegex(RuntimeError, "could not clear the stale"):
            manager.ensure_replicas([{"name": "Alpha", "provider": "local"}])

        commands = [call.args[0][:2] for call in controller._run_cmd.call_args_list]
        self.assertNotIn(["docker", "run"], commands)

    def test_remove_replica_deletes_the_status_before_removing_the_container(self):
        controller = _fake_controller()
        manager = Provisioner(controller)
        manager.ensure_replicas([{"name": "Alpha", "provider": "local"}])
        controller.redis.set(self.STATUS_KEY, "healthy")
        seen_at_rm = []
        run_cmd = controller._run_cmd.side_effect

        def observe(cmd, host, user=None):
            if cmd[:3] == ["docker", "rm", "-f"]:
                seen_at_rm.append(controller.redis.get(self.STATUS_KEY))
            return run_cmd(cmd, host, user)

        controller._run_cmd = observe

        manager.remove_replica("Alpha-0", drain=False)

        self.assertEqual(seen_at_rm, [None])
        self.assertNotIn(self.STATUS_KEY, controller.redis.strings)

    def test_a_status_that_cannot_be_deleted_does_not_stop_the_teardown(self):
        controller = _fake_controller()
        manager = Provisioner(controller)
        manager.ensure_replicas([{"name": "Alpha", "provider": "local"}])
        delete = controller.redis.delete

        def refuse_status(*keys):
            if any(key.endswith(":status") for key in keys):
                raise ConnectionError("redis away")
            delete(*keys)

        controller.redis.delete = refuse_status

        with self.assertLogs("canyonos_core.reconciler.provisioner", level="WARNING"):
            manager.remove_replica("Alpha-0", drain=False)

        self.assertEqual(controller.redis.hgetall("agent_instance:Alpha-0"), {})
