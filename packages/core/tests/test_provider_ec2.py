# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

import os
import stat
import sys
import tempfile
import threading
import time
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from botocore.exceptions import ClientError, WaiterError

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from canyonos_core.reconciler.providers.EC2 import _provider as ec2_provider
from fakes import _bind_fake_ec2


class EC2ProviderTests(unittest.TestCase):
    def setUp(self):
        self.controller, self.fake_client = _bind_fake_ec2(self)
        self.key_path = self.controller.config["ssh_private_key_path"]

    def test_ssh_key_path_generates_default_key_when_unset(self):
        self.controller.config.pop("ssh_private_key_path")
        default_dir = tempfile.mkdtemp()
        default_path = os.path.join(default_dir, "canyonos_ec2")

        try:
            with patch.object(ec2_provider, "DEFAULT_SSH_KEY_PATH", default_path):
                self.assertEqual(ec2_provider._ssh_key_path(), default_path)

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
            with patch.object(ec2_provider, "DEFAULT_SSH_KEY_PATH", default_path):
                threads = [
                    threading.Thread(
                        target=ec2_provider._generate_default_key, args=(default_path,)
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
            ec2_provider._ssh_key_path()

    def test_ssh_key_path_rejects_insecure_ssh_private_key_permissions(self):
        os.chmod(self.key_path, 0o644)

        with self.assertRaisesRegex(ValueError, "insecure permissions 0644"):
            ec2_provider._ssh_key_path()

    def _import_key_pair(self):
        cfg = self.controller.config["ec2"]
        return ec2_provider._ensure_key_pair_imported(
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

    def test_start_machine_uses_ec2_client(self):
        spec = {"machine_type": "t3.small"}

        machine = ec2_provider.start_machine(spec, "launch-1")

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
            {"Key": "Name", "Value": "canyonos-launch-1"},
        )
        self.assertEqual(request["ClientToken"], "launch-1")
        self.assertEqual(self.fake_client.waiter.calls, [])
        self.assertEqual(machine, {"machine_id": "i-test1"})
        self.assertEqual(
            self.fake_client.client_calls,
            [{"service_name": "ec2", "region_name": "us-east-1"}],
        )

    def test_start_machine_requests_spot_market_type(self):
        spec = {
            "name": "Spot",
            "provider": "EC2",
            "machine_type": "t3.small",
            "market_type": "spot",
        }

        ec2_provider.start_machine(spec, "launch-1")

        self.assertEqual(
            self.fake_client.run_requests[0]["InstanceMarketOptions"],
            {"MarketType": "spot"},
        )

    def test_wait_fails_when_no_public_ip_arrives(self):
        self.fake_client.public_ip = None
        self.controller.config["ec2"]["public_ip_timeout"] = 0
        spec = {"name": "Tagged", "provider": "EC2", "machine_type": "t3.small"}
        machine = ec2_provider.start_machine(spec, "launch-1")

        with self.assertRaisesRegex(RuntimeError, "never got a public IP"):
            ec2_provider.wait_for_machine(machine)

    def test_start_machine_attaches_iam_profile_when_configured(self):
        self.controller.config["ec2"]["iam_profile_name"] = "my-custom-profile"
        spec = {"name": "Tagged", "provider": "EC2", "machine_type": "t3.small"}

        ec2_provider.start_machine(spec, "launch-1")

        request = self.fake_client.run_requests[0]
        self.assertEqual(request["IamInstanceProfile"], {"Name": "my-custom-profile"})

    def test_wait_for_machine_returns_its_addresses_user_and_container_timeout(self):
        spec = {"name": "Tagged", "provider": "EC2", "machine_type": "t3.small"}
        machine = ec2_provider.start_machine(spec, "launch-1")

        waited = ec2_provider.wait_for_machine(machine)

        self.assertEqual(
            waited,
            {
                "private_host": "10.0.0.30",
                "public_host": "54.10.20.30",
                "user": "ubuntu",
                "container_timeout": 180,
            },
        )
        self.assertEqual(self.fake_client.waiter.calls, [["i-test1"]])
        self.controller._run_cmd.assert_called_once_with(
            ["true"], "10.0.0.30", user="ubuntu"
        )

    def test_a_machine_that_never_answers_ssh_is_left_for_the_provisioner(self):
        """The provisioner terminates it from the saved record, so it is never done twice."""
        self.controller._run_cmd.return_value = SimpleNamespace(
            returncode=255, stderr="Connection refused", stdout=""
        )
        spec = {"name": "Broken", "provider": "EC2", "machine_type": "t3.small"}
        machine = ec2_provider.start_machine(spec, "launch-1")

        with (
            patch.object(ec2_provider.time, "sleep"),
            self.assertRaisesRegex(TimeoutError, "SSH never became ready"),
        ):
            ec2_provider.wait_for_machine(machine)

        self.assertEqual(self.fake_client.terminate_requests, [])

    def test_a_machine_that_never_runs_says_why(self):
        spec = {"name": "Broken", "provider": "EC2", "machine_type": "t3.small"}
        machine = ec2_provider.start_machine(spec, "launch-1")
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
            ec2_provider.wait_for_machine(machine)

    def test_a_config_without_an_ec2_section_says_so(self):
        """Records can outlive the config that made them, e.g. across a restart."""
        del self.controller.config["ec2"]
        self.controller.config_path = "/app/global_controller.yaml"

        with self.assertRaisesRegex(
            RuntimeError, "/app/global_controller.yaml has no ec2: section"
        ):
            ec2_provider.terminate_machine({"machine_id": "i-test1"})

    def test_terminate_machine_terminates_by_machine_id(self):
        ec2_provider.start_machine({"name": "A", "machine_type": "t3.small"}, "l-1")

        ec2_provider.terminate_machine({"machine_id": "i-test1"})
        self.assertEqual(self.fake_client.terminate_requests, [["i-test1"]])

    def test_an_unfinished_launch_is_found_by_its_launch_id(self):
        """A launch that died before its machine id was saved still gets terminated."""
        ec2_provider.start_machine({"name": "A", "machine_type": "t3.small"}, "l-1")
        record = {"launch_id": "l-1", "launched_at": str(time.time())}

        ec2_provider.terminate_machine(record)
        self.assertEqual(self.fake_client.terminate_requests, [["i-test1"]])

    def test_a_recent_launch_aws_does_not_list_yet_is_retried(self):
        record = {"launch_id": "l-1", "launched_at": str(time.time())}

        with self.assertRaisesRegex(RuntimeError, "AWS does not list launch l-1 yet"):
            ec2_provider.terminate_machine(record)

    def test_terminating_a_machine_aws_no_longer_knows_succeeds(self):
        self.fake_client.terminate_instances = MagicMock(
            side_effect=ClientError(
                {"Error": {"Code": "InvalidInstanceID.NotFound", "Message": "gone"}},
                "TerminateInstances",
            )
        )

        ec2_provider.terminate_machine({"machine_id": "i-test1"})


if __name__ == "__main__":
    unittest.main()
