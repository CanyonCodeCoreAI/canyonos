import os
import stat
import sys
import tempfile
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from botocore.exceptions import ClientError, WaiterError

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from canyonos_core.reconciler.providers.EC2 import _runtime as ec2_runtime
from fakes import _bind_fake_ec2


class EC2RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.controller, self.fake_client = _bind_fake_ec2(self)
        self.key_path = self.controller.config["ssh_private_key_path"]

    def test_ssh_key_path_generates_default_key_when_unset(self):
        self.controller.config.pop("ssh_private_key_path")
        default_dir = tempfile.mkdtemp()
        default_path = os.path.join(default_dir, "canyonos_ec2")

        try:
            with patch.object(ec2_runtime, "DEFAULT_SSH_KEY_PATH", default_path):
                self.assertEqual(ec2_runtime._ssh_key_path(), default_path)

            self.assertTrue(os.path.isfile(default_path))
            mode = stat.S_IMODE(os.stat(default_path).st_mode)
            self.assertEqual(mode, 0o600)
        finally:
            os.unlink(default_path)
            if os.path.exists(f"{default_path}.pub"):
                os.unlink(f"{default_path}.pub")
            os.rmdir(default_dir)

    def test_default_key_generation_is_race_safe(self):
        default_dir = tempfile.mkdtemp()
        default_path = os.path.join(default_dir, "canyonos_ec2")

        try:
            with patch.object(ec2_runtime, "DEFAULT_SSH_KEY_PATH", default_path):
                threads = [
                    threading.Thread(
                        target=ec2_runtime._generate_default_key, args=(default_path,)
                    )
                    for _ in range(5)
                ]
                for t in threads:
                    t.start()
                for t in threads:
                    t.join()

            self.assertTrue(os.path.isfile(default_path))
        finally:
            os.unlink(default_path)
            if os.path.exists(f"{default_path}.pub"):
                os.unlink(f"{default_path}.pub")
            os.rmdir(default_dir)

    def test_ssh_key_path_rejects_missing_ssh_private_key(self):
        self.controller.config["ssh_private_key_path"] = "/tmp/missing-canyonos-key"

        with self.assertRaisesRegex(ValueError, "does not exist"):
            ec2_runtime._ssh_key_path()

    def test_ssh_key_path_rejects_insecure_ssh_private_key_permissions(self):
        os.chmod(self.key_path, 0o644)

        with self.assertRaisesRegex(ValueError, "insecure permissions 0644"):
            ec2_runtime._ssh_key_path()

    def _import_key_pair(self):
        cfg = self.controller.config["ec2"]
        return ec2_runtime._ensure_key_pair_imported(
            cfg, self.key_path, self.fake_client
        )

    def test_key_pair_name_scoped_by_project_id_and_stable_for_same_key(self):
        first_name = self._import_key_pair()
        self.assertRegex(first_name, r"^canyonos-ec2-default-[0-9a-f]{8}$")

        self.assertEqual(self._import_key_pair(), first_name)

        self.controller.config["project_id"] = "my-project"
        second_name = self._import_key_pair()
        self.assertNotEqual(second_name, first_name)
        self.assertTrue(second_name.startswith("canyonos-ec2-my-project-"))

    def test_key_pair_imported_once_per_region(self):
        self._import_key_pair()
        self._import_key_pair()
        self.assertEqual(len(self.fake_client.import_key_pair_requests), 1)

        self.controller.config["ec2"]["region"] = "us-west-2"
        self._import_key_pair()
        self.assertEqual(len(self.fake_client.import_key_pair_requests), 2)

    def test_key_pair_tolerates_already_imported_key_pair(self):
        self.fake_client.import_key_pair = MagicMock(
            side_effect=ClientError(
                {"Error": {"Code": "InvalidKeyPair.Duplicate", "Message": "boom"}},
                "ImportKeyPair",
            )
        )

        self._import_key_pair()

    def test_key_pair_reraises_other_key_pair_errors(self):
        self.fake_client.import_key_pair = MagicMock(
            side_effect=ClientError(
                {"Error": {"Code": "UnauthorizedOperation", "Message": "boom"}},
                "ImportKeyPair",
            )
        )

        with self.assertRaises(ClientError):
            self._import_key_pair()

    def test_provision_uses_ec2_client(self):
        spec = {
            "name": "Tagged",
            "provider": "EC2",
            "instance_type": "t3.small",
            "redis_port": 6390,
        }

        provisioned = ec2_runtime.provision_instance(spec, 2, None, "launch-1")

        request = self.fake_client.run_requests[0]
        self.assertEqual(request["ImageId"], "ami-123456")
        self.assertNotIn("InstanceMarketOptions", request)
        self.assertRegex(request["KeyName"], r"^canyonos-ec2-default-[0-9a-f]{8}$")
        self.assertEqual(
            request["NetworkInterfaces"],
            [
                {
                    "DeviceIndex": 0,
                    "SubnetId": "subnet-123456",
                    "Groups": ["sg-123456"],
                    "AssociatePublicIpAddress": True,
                }
            ],
        )
        self.assertNotIn("SubnetId", request)
        self.assertNotIn("UserData", request)
        self.assertNotIn("IamInstanceProfile", request)
        self.assertEqual(
            self.fake_client.import_key_pair_requests[0]["KeyName"],
            request["KeyName"],
        )
        self.assertEqual(
            request["TagSpecifications"][0]["Tags"][0],
            {"Key": "Name", "Value": "canyonos-Tagged-2"},
        )
        self.assertEqual(request["ClientToken"], "launch-1")
        self.assertEqual(self.fake_client.waiter.calls, [])
        self.assertEqual(provisioned["runtime_id"], "canyonos-tagged-2--i-test1")
        self.assertEqual(
            self.fake_client.client_calls,
            [{"service_name": "ec2", "region_name": "us-east-1"}],
        )

    def test_provision_requests_spot_market_type(self):
        spec = {
            "name": "Spot",
            "provider": "EC2",
            "instance_type": "t3.small",
            "market_type": "spot",
        }

        ec2_runtime.provision_instance(spec, 0, None, "launch-1")

        self.assertEqual(
            self.fake_client.run_requests[0]["InstanceMarketOptions"],
            {"MarketType": "spot"},
        )

    def test_bootstrap_fails_when_no_public_ip_arrives(self):
        self.fake_client.public_ip = None
        self.controller.config["ec2"]["public_ip_timeout"] = 0
        spec = {"name": "Tagged", "provider": "EC2", "instance_type": "t3.small"}
        provisioned = ec2_runtime.provision_instance(spec, 0, None, "launch-1")

        with self.assertRaisesRegex(RuntimeError, "never got a public IP"):
            ec2_runtime.bootstrap_instance(provisioned, spec, 0, "agent-id-0")

    def test_provision_attaches_instance_profile_when_configured(self):
        self.controller.config["ec2"]["instance_profile_name"] = "my-custom-profile"
        spec = {"name": "Tagged", "provider": "EC2", "instance_type": "t3.small"}

        ec2_runtime.provision_instance(spec, 0, None, "launch-1")

        request = self.fake_client.run_requests[0]
        self.assertEqual(request["IamInstanceProfile"], {"Name": "my-custom-profile"})

    def test_provision_and_bootstrap_instance_return_runtime_record(self):
        spec = {
            "name": "Tagged",
            "provider": "EC2",
            "instance_type": "t3.small",
            "redis_port": 6390,
        }

        with (
            patch.object(ec2_runtime, "_bootstrap_instance"),
            patch.object(ec2_runtime, "_check_controller_health", return_value=True),
        ):
            provisioned = ec2_runtime.provision_instance(spec, 2, None, "launch-1")
            instance = ec2_runtime.bootstrap_instance(
                provisioned, spec, 2, "agent-id-2"
            )

        self.assertEqual(instance["private_host"], "10.0.0.30")
        self.assertEqual(instance["public_host"], "54.10.20.30")
        self.assertEqual(instance["endpoint"], "10.0.0.30:50051")
        self.assertEqual(instance["routing_endpoint"], "10.0.0.30:50051")
        self.assertEqual(instance["redis_host"], "host.docker.internal")
        self.assertEqual(instance["redis_port"], "6390")
        self.assertIn("--i-test1", instance["runtime_id"])

    def test_a_database_is_routed_on_its_published_db_port(self):
        spec = {
            "name": "Pg",
            "provider": "EC2",
            "instance_type": "t3.small",
            "type": "database",
            "db_port": 5433,
        }

        with (
            patch.object(ec2_runtime, "_bootstrap_instance"),
            patch.object(ec2_runtime, "_check_controller_health", return_value=True),
        ):
            provisioned = ec2_runtime.provision_instance(spec, 0, None, "launch-1")
            instance = ec2_runtime.bootstrap_instance(
                provisioned, spec, 0, "agent-id-0"
            )

        self.assertEqual(instance["host_port"], "5433")
        self.assertEqual(instance["routing_endpoint"], "10.0.0.30:5433")

    def test_a_failed_bootstrap_leaves_the_instance_for_the_provisioner(self):
        """The provisioner terminates it from the saved record, so it is never done twice."""
        spec = {"name": "Broken", "provider": "EC2", "instance_type": "t3.small"}
        provisioned = ec2_runtime.provision_instance(spec, 0, None, "launch-1")

        with (
            patch.object(
                ec2_runtime, "_bootstrap_instance", side_effect=RuntimeError("boom")
            ),
            self.assertRaisesRegex(RuntimeError, "boom"),
        ):
            ec2_runtime.bootstrap_instance(provisioned, spec, 0, "agent-id-0")

        self.assertEqual(self.fake_client.terminate_requests, [])

    def test_an_instance_that_never_runs_says_why(self):
        spec = {"name": "Broken", "provider": "EC2", "instance_type": "t3.small"}
        provisioned = ec2_runtime.provision_instance(spec, 0, None, "launch-1")
        self.fake_client.waiter.wait = MagicMock(
            side_effect=WaiterError(
                "InstanceRunning",
                "terminal failure state",
                {
                    "Reservations": [
                        {"Instances": [{"StateReason": {"Message": "spot reclaimed"}}]}
                    ]
                },
            )
        )

        with self.assertRaisesRegex(
            RuntimeError, "i-test1 never reached running: spot reclaimed"
        ):
            ec2_runtime.bootstrap_instance(provisioned, spec, 0, "agent-id-0")

    def test_a_config_without_an_ec2_section_says_so(self):
        """Records can outlive the config that made them, e.g. across a restart."""
        del self.controller.config["ec2"]
        self.controller.config_path = "/app/global_controller.yaml"

        with self.assertRaisesRegex(
            RuntimeError, "/app/global_controller.yaml has no ec2: section"
        ):
            ec2_runtime.terminate_instance({"runtime_id": "canyonos-tagged-0--i-test1"})

    def test_bootstrap_uses_ssh_user(self):
        spec = {"name": "Tagged", "provider": "EC2", "redis_port": 6390}
        with (
            patch.object(ec2_runtime.time, "sleep"),
            patch.object(
                ec2_runtime.subprocess,
                "run",
                return_value=SimpleNamespace(returncode=0, stderr="", stdout=""),
            ),
            patch.object(
                ec2_runtime, "RedisClient", return_value=MagicMock()
            ) as redis_client,
        ):
            ec2_runtime._bootstrap_instance(
                "10.0.0.30",
                spec,
                2,
                self.controller.config["ec2"],
                redis_host="10.0.0.30",
                redis_port=6390,
                agent_id="agent-id-2",
            )

        self.assertTrue(self.controller._run_cmd.called)
        for call in self.controller._run_cmd.call_args_list:
            self.assertEqual(call.args[1], "10.0.0.30")
            self.assertEqual(call.kwargs["user"], "ubuntu")
        redis_client.assert_called_once_with(host="10.0.0.30", port=6390)
        agent_cmd = self.controller._run_cmd.call_args_list[-1].args[0]
        self.assertIn("CANYONOS_AGENT_HOST=10.0.0.30", agent_cmd)
        # SSH wait + Redis container + agent container
        self.assertEqual(self.controller._run_cmd.call_count, 3)
        self.assertEqual(
            self.controller._run_cmd.call_args_list[-1].args[0][0], "docker"
        )
        self.assertNotIn(
            "-it",
            self.controller._run_cmd.call_args_list[-1].args[0],
            "non-interactive agent containers must be created with stdin closed",
        )

    def test_bootstrap_passes_logs_enabled_env_var_with_its_flag(self):
        """CANYONOS_LOGS_ENABLED must be preceded by its own '-e' -- a bare
        'KEY=value' string with no flag is treated by `docker run` as the IMAGE
        positional argument, breaking the launch entirely."""
        self.controller.config["logs"] = True
        spec = {"name": "Tagged", "provider": "EC2", "redis_port": 6390}
        with (
            patch.object(ec2_runtime.time, "sleep"),
            patch.object(
                ec2_runtime.subprocess,
                "run",
                return_value=SimpleNamespace(returncode=0, stderr="", stdout=""),
            ),
            patch.object(ec2_runtime, "RedisClient", return_value=MagicMock()),
        ):
            ec2_runtime._bootstrap_instance(
                "10.0.0.30",
                spec,
                2,
                self.controller.config["ec2"],
                redis_host="10.0.0.30",
                redis_port=6390,
                agent_id="agent-id-2",
            )

        cmd = self.controller._run_cmd.call_args_list[-1].args[0]
        index = cmd.index("CANYONOS_LOGS_ENABLED=true")
        self.assertEqual(cmd[index - 1], "-e")

    def test_terminating_an_instance_aws_no_longer_knows_succeeds(self):
        self.fake_client.terminate_instances = MagicMock(
            side_effect=ClientError(
                {"Error": {"Code": "InvalidInstanceID.NotFound", "Message": "gone"}},
                "TerminateInstances",
            )
        )

        ec2_runtime.terminate_instance({"runtime_id": "canyonos-tagged-0--i-test1"})

    def test_health_check_error_message_mentions_ec2_runtime_endpoint(self):
        with patch.object(ec2_runtime.time, "time", side_effect=[0, 999]):
            with self.assertRaisesRegex(
                TimeoutError, "EC2 runtime endpoint never became reachable"
            ):
                ec2_runtime._check_controller_health("10.0.0.30:50051", timeout=1)


if __name__ == "__main__":
    unittest.main()
