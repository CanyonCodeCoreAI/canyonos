import os
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from botocore.exceptions import ClientError

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from canyonos_core.reconciler.providers.EC2 import _runtime as ec2_runtime


class _FakeWaiter:
    def __init__(self):
        self.calls = []

    def wait(self, InstanceIds):
        self.calls.append(list(InstanceIds))


class _FakeEC2Client:
    def __init__(self, public_ip="54.10.20.30", private_ip="10.0.0.30"):
        self.public_ip = public_ip
        self.private_ip = private_ip
        self.instances = {}
        self.run_requests = []
        self.terminate_requests = []
        self.import_key_pair_requests = []
        self.waiter = _FakeWaiter()

    def import_key_pair(self, **kwargs):
        self.import_key_pair_requests.append(kwargs)
        return {}

    def run_instances(self, **kwargs):
        self.run_requests.append(kwargs)
        instance_id = f"i-test{len(self.run_requests)}"
        self.instances[instance_id] = {
            "InstanceId": instance_id,
            "State": {"Name": "running"},
            "PrivateIpAddress": self.private_ip,
            "PublicIpAddress": self.public_ip,
        }
        return {"Instances": [{"InstanceId": instance_id}]}

    def get_waiter(self, name):
        assert name == "instance_running"
        return self.waiter

    def describe_instances(self, InstanceIds):
        return {
            "Reservations": [
                {"Instances": [self.instances[instance_id]]}
                for instance_id in InstanceIds
                if instance_id in self.instances
            ]
        }

    def terminate_instances(self, InstanceIds):
        self.terminate_requests.append(list(InstanceIds))
        return {}


class EC2RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.original_controller = ec2_runtime._controller
        key_file = tempfile.NamedTemporaryFile(delete=False)
        key_file.close()
        self.key_path = key_file.name
        os.unlink(self.key_path)
        subprocess.run(
            ["ssh-keygen", "-t", "ed25519", "-N", "", "-f", self.key_path, "-q"],
            check=True,
        )
        os.chmod(self.key_path, 0o600)
        self.fake_client = _FakeEC2Client()
        self.client_calls = []
        self.controller = SimpleNamespace(
            config={
                "redis": {"host": "redis.internal", "port": 6379},
                "ec2": {
                    "ami_id": "ami-123456",
                    "subnet_id": "subnet-123456",
                    "security_group_ids": ["sg-123456"],
                    "region": "us-east-1",
                    "ssh_user": "ubuntu",
                    "ssh_private_key_path": self.key_path,
                },
            },
            registry_url=None,
            _run_cmd=MagicMock(
                return_value=SimpleNamespace(returncode=0, stderr="", stdout="")
            ),
            _ssh_args=lambda host, user=None: ["ssh", f"{user}@{host}"],
        )
        ec2_runtime._controller = self.controller
        ec2_runtime._imported_key_pairs.clear()
        self.client_patch = patch.object(
            ec2_runtime.boto3,
            "client",
            side_effect=self._make_client,
        )
        self.client_patch.start()

    def tearDown(self):
        self.client_patch.stop()
        os.unlink(self.key_path)
        os.unlink(f"{self.key_path}.pub")
        ec2_runtime._controller = self.original_controller

    def _make_client(self, service_name, region_name=None):
        self.client_calls.append(
            {"service_name": service_name, "region_name": region_name}
        )
        assert service_name == "ec2"
        return self.fake_client

    def test_ec2_config_fails_when_required_fields_are_missing(self):
        self.controller.config["ec2"].pop("subnet_id")

        with self.assertRaisesRegex(ValueError, "Missing EC2 config"):
            ec2_runtime._ec2_config()

    def test_ssh_key_path_generates_default_key_when_unset(self):
        self.controller.config["ec2"].pop("ssh_private_key_path")
        default_dir = tempfile.mkdtemp()
        default_path = os.path.join(default_dir, "canyonos_ec2")

        try:
            with patch.object(ec2_runtime, "DEFAULT_SSH_KEY_PATH", default_path):
                self.assertEqual(
                    ec2_runtime._ssh_key_path(self.controller.config["ec2"]),
                    default_path,
                )

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
        self.controller.config["ec2"]["ssh_private_key_path"] = (
            "/tmp/missing-canyonos-key"
        )

        with self.assertRaisesRegex(ValueError, "does not exist"):
            ec2_runtime._ssh_key_path(self.controller.config["ec2"])

    def test_ssh_key_path_rejects_insecure_ssh_private_key_permissions(self):
        os.chmod(self.key_path, 0o644)

        with self.assertRaisesRegex(ValueError, "insecure permissions 0644"):
            ec2_runtime._ssh_key_path(self.controller.config["ec2"])

    def _import_key_pair(self):
        cfg = ec2_runtime._ec2_config()
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

        provisioned = ec2_runtime.provision_instance(spec, 2)

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
        self.assertEqual(self.fake_client.waiter.calls, [["i-test1"]])
        self.assertEqual(provisioned["private_host"], "10.0.0.30")
        self.assertEqual(provisioned["public_host"], "54.10.20.30")
        self.assertEqual(
            self.client_calls,
            [{"service_name": "ec2", "region_name": "us-east-1"}],
        )

    def test_provision_requests_spot_market_type(self):
        spec = {
            "name": "Spot",
            "provider": "EC2",
            "instance_type": "t3.small",
            "market_type": "spot",
        }

        ec2_runtime.provision_instance(spec, 0)

        self.assertEqual(
            self.fake_client.run_requests[0]["InstanceMarketOptions"],
            {"MarketType": "spot"},
        )

    def test_provision_fails_when_no_public_ip_arrives(self):
        self.fake_client.public_ip = None
        self.controller.config["ec2"]["public_ip_timeout"] = 0
        spec = {"name": "Tagged", "provider": "EC2", "instance_type": "t3.small"}

        with self.assertRaisesRegex(RuntimeError, "never got a public IP"):
            ec2_runtime.provision_instance(spec, 0)

    def test_provision_attaches_instance_profile_when_configured(self):
        self.controller.config["ec2"]["instance_profile_name"] = "my-custom-profile"
        spec = {"name": "Tagged", "provider": "EC2", "instance_type": "t3.small"}

        ec2_runtime.provision_instance(spec, 0)

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
            provisioned = ec2_runtime.provision_instance(spec, 2)
            instance = ec2_runtime.bootstrap_instance(
                provisioned, spec, 2, "agent-id-2"
            )

        self.assertEqual(instance["private_host"], "10.0.0.30")
        self.assertEqual(instance["public_host"], "54.10.20.30")
        self.assertEqual(instance["endpoint"], "10.0.0.30:50051")
        self.assertEqual(instance["redis_host"], "host.docker.internal")
        self.assertEqual(instance["redis_port"], "6390")
        self.assertIn("--i-test1", instance["runtime_id"])

    def test_bootstrap_instance_terminates_instance_when_bootstrap_fails(self):
        spec = {"name": "Broken", "provider": "EC2", "instance_type": "t3.small"}
        provisioned = ec2_runtime.provision_instance(spec, 0)

        with (
            patch.object(
                ec2_runtime, "_bootstrap_instance", side_effect=RuntimeError("boom")
            ),
            self.assertRaisesRegex(RuntimeError, "boom"),
        ):
            ec2_runtime.bootstrap_instance(provisioned, spec, 0, "agent-id-0")

        self.assertEqual(self.fake_client.terminate_requests, [["i-test1"]])

    def test_bootstrap_failure_terminates_even_when_key_import_would_fail(self):
        spec = {"name": "Broken", "provider": "EC2", "instance_type": "t3.small"}
        provisioned = ec2_runtime.provision_instance(spec, 0)
        ec2_runtime._imported_key_pairs.clear()
        self.fake_client.import_key_pair = MagicMock(
            side_effect=ClientError(
                {"Error": {"Code": "UnauthorizedOperation", "Message": "denied"}},
                "ImportKeyPair",
            )
        )

        with (
            patch.object(
                ec2_runtime, "_bootstrap_instance", side_effect=RuntimeError("boom")
            ),
            self.assertRaisesRegex(RuntimeError, "boom"),
        ):
            ec2_runtime.bootstrap_instance(provisioned, spec, 0, "agent-id-0")

        self.fake_client.import_key_pair.assert_not_called()
        self.assertEqual(self.fake_client.terminate_requests, [["i-test1"]])

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

    def test_bootstrap_instance_terminates_instance_when_health_check_fails(self):
        spec = {"name": "Broken", "provider": "EC2", "instance_type": "t3.small"}
        provisioned = ec2_runtime.provision_instance(spec, 0)

        with (
            patch.object(ec2_runtime, "_bootstrap_instance"),
            patch.object(
                ec2_runtime,
                "_check_controller_health",
                side_effect=TimeoutError("boom"),
            ),
            self.assertRaises(TimeoutError),
        ):
            ec2_runtime.bootstrap_instance(provisioned, spec, 0, "agent-id-0")

        self.assertEqual(self.fake_client.terminate_requests, [["i-test1"]])

    def test_terminate_instance_still_cleans_host_side_maps(self):
        spec = {"name": "Tagged", "provider": "EC2", "instance_type": "t3.small"}
        provisioned = ec2_runtime.provision_instance(spec, 0)
        self.controller.redis_containers = {"10.0.0.30": "redis-box"}
        self.controller.node_redis = {"10.0.0.30": object()}

        ec2_runtime.terminate_instance(
            {
                "runtime_id": provisioned["runtime_id"],
                "private_host": "10.0.0.30",
            }
        )

        self.assertEqual(self.fake_client.terminate_requests, [["i-test1"]])
        self.assertNotIn("10.0.0.30", self.controller.redis_containers)
        self.assertNotIn("10.0.0.30", self.controller.node_redis)

    def test_health_check_error_message_mentions_ec2_runtime_endpoint(self):
        with patch.object(ec2_runtime.time, "time", side_effect=[0, 999]):
            with self.assertRaisesRegex(
                TimeoutError, "EC2 runtime endpoint never became reachable"
            ):
                ec2_runtime._check_controller_health("10.0.0.30:50051", timeout=1)


if __name__ == "__main__":
    unittest.main()
