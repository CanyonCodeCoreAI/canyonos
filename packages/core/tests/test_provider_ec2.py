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


SPEC = {"machine_type": "t3.small"}
SPEC_NETWORK = {
    "region": "us-east-1",
    "subnet_id": "subnet-123456",
    "security_group_ids": ["sg-123456"],
}


class EC2ProviderTests(unittest.TestCase):
    def setUp(self):
        self.controller, self.fake_client = _bind_fake_ec2(self)
        self.key_path = self.controller.config["ssh_private_key_path"]
        # Not on EC2, unless a test says otherwise.
        own_machine = patch.object(
            ec2_provider, "_deploying_machine", return_value=None
        )
        own_machine.start()
        self.addCleanup(own_machine.stop)

    def test_ensure_ssh_key_generates_default_key_when_unset(self):
        self.controller.config.pop("ssh_private_key_path")
        default_dir = tempfile.mkdtemp()
        default_path = os.path.join(default_dir, "canyonos_ec2")

        try:
            with patch.object(ec2_provider, "DEFAULT_SSH_KEY_PATH", default_path):
                self.assertEqual(ec2_provider._ensure_ssh_key(), default_path)

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

    def test_ensure_ssh_key_rejects_missing_ssh_private_key(self):
        self.controller.config["ssh_private_key_path"] = "/tmp/missing-canyonos-key"

        with self.assertRaisesRegex(ValueError, "was not found"):
            ec2_provider._ensure_ssh_key()

    def test_ensure_ssh_key_rejects_insecure_ssh_private_key_permissions(self):
        os.chmod(self.key_path, 0o644)

        with self.assertRaisesRegex(ValueError, "insecure permissions 0644"):
            ec2_provider._ensure_ssh_key()

    def _import_key_pair(self):
        cfg = self.controller.config["ec2-pool"]
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

        self.controller.config["ec2-pool"]["region"] = "us-west-2"
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

        machine = ec2_provider.start_machine(SPEC, "launch-1")

        request = self.fake_client.run_requests[0]
        self.assertEqual(request["ImageId"], "ami-123456")
        self.assertEqual(request["InstanceType"], "t3.small")
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

    def test_start_machine_tags_the_machine_it_was_deployed_from(self):
        own_machine = {"machine_id": "i-deployer", **SPEC_NETWORK}
        with patch.object(ec2_provider, "_deploying_machine", return_value=own_machine):
            ec2_provider.start_machine(SPEC, "launch-1")

        tags = self.fake_client.run_requests[0]["TagSpecifications"][0]["Tags"]
        self.assertIn({"Key": "canyonos-deployed-from", "Value": "i-deployer"}, tags)

    def test_start_machine_off_ec2_has_no_deployed_from_tag(self):
        ec2_provider.start_machine(SPEC, "launch-1")

        tags = self.fake_client.run_requests[0]["TagSpecifications"][0]["Tags"]
        self.assertNotIn("canyonos-deployed-from", [tag["Key"] for tag in tags])

    def test_start_machine_requests_spot_market_type(self):
        ec2_provider.start_machine(
            {"machine_type": "t3.small", "market_type": "spot"}, "launch-1"
        )

        self.assertEqual(
            self.fake_client.run_requests[0]["InstanceMarketOptions"],
            {"MarketType": "spot"},
        )

    def test_wait_fails_when_no_public_ip_arrives(self):
        self.fake_client.public_ip = None
        self.controller.config["ec2-pool"]["public_ip_timeout"] = 0
        machine = ec2_provider.start_machine(SPEC, "launch-1")

        with self.assertRaisesRegex(RuntimeError, "never got a public IP"):
            ec2_provider.wait_for_machine(machine)

    def test_start_machine_attaches_iam_profile_when_configured(self):
        self.controller.config["ec2-pool"]["iam_profile_name"] = "my-custom-profile"

        ec2_provider.start_machine(SPEC, "launch-1")

        request = self.fake_client.run_requests[0]
        self.assertEqual(request["IamInstanceProfile"], {"Name": "my-custom-profile"})

    def test_wait_for_machine_returns_its_addresses_user_and_container_timeout(self):
        machine = ec2_provider.start_machine(SPEC, "launch-1")

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
        machine = ec2_provider.start_machine(SPEC, "launch-1")

        with (
            patch.object(ec2_provider.time, "sleep"),
            self.assertRaisesRegex(TimeoutError, "SSH never became ready"),
        ):
            ec2_provider.wait_for_machine(machine)

        self.assertEqual(self.fake_client.terminate_requests, [])

    def test_a_machine_that_never_runs_says_why(self):
        machine = ec2_provider.start_machine(SPEC, "launch-1")
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
        del self.controller.config["ec2-pool"]
        self.controller.config_path = "/app/global_controller.yaml"

        with (
            patch.object(ec2_provider, "_deploying_machine", return_value=None),
            self.assertRaisesRegex(
                RuntimeError,
                "/app/global_controller.yaml does not set ec2-pool: region",
            ),
        ):
            ec2_provider.terminate_machine({"machine_id": "i-test1"})

    def test_terminate_machine_terminates_by_machine_id(self):
        ec2_provider.start_machine(SPEC, "l-1")

        ec2_provider.terminate_machine({"machine_id": "i-test1"})
        self.assertEqual(self.fake_client.terminate_requests, [["i-test1"]])

    def test_an_unfinished_launch_is_found_by_its_launch_id(self):
        """A launch that died before its machine id was saved still gets terminated."""
        ec2_provider.start_machine(SPEC, "l-1")
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


class EC2NetworkDefaultsTests(unittest.TestCase):
    """`ec2-pool:` keys left out fall back to the deploying machine's own network."""

    OWN_NETWORK = {
        "region": "eu-west-1",
        "subnet_id": "subnet-own",
        "security_group_ids": ["sg-own-1", "sg-own-2"],
    }

    def setUp(self):
        self.controller, _ = _bind_fake_ec2(self)
        self.controller.config_path = "global_controller.yaml"
        ec2_provider._own_machine = None
        ec2_provider._own_machine_failed_at = None
        self.addCleanup(setattr, ec2_provider, "_own_machine", None)
        self.addCleanup(setattr, ec2_provider, "_own_machine_failed_at", None)

    def test_missing_network_keys_come_from_the_deploying_machine(self):
        self.controller.config["ec2-pool"] = {"ami_id": "ami-123456"}

        with patch.object(
            ec2_provider, "_deploying_machine", return_value=self.OWN_NETWORK
        ):
            cfg = ec2_provider._ec2_config()

        self.assertEqual(cfg, {"ami_id": "ami-123456", **self.OWN_NETWORK})

    def test_keys_the_config_sets_win_over_the_deploying_machine(self):
        self.controller.config["ec2-pool"] = {"subnet_id": "subnet-chosen"}

        with patch.object(
            ec2_provider, "_deploying_machine", return_value=self.OWN_NETWORK
        ):
            cfg = ec2_provider._ec2_config()

        self.assertEqual(cfg["subnet_id"], "subnet-chosen")
        self.assertEqual(cfg["region"], "eu-west-1")

    def test_ec2_auto_reads_its_own_section(self):
        self.controller.config["provider"] = "ec2-assign"
        self.controller.config["ec2-assign"] = {
            **self.controller.config.pop("ec2-pool"),
            "subnet_id": "subnet-auto",
        }

        self.assertEqual(ec2_provider._ec2_config()["subnet_id"], "subnet-auto")

    def test_a_complete_config_never_reads_metadata(self):
        with patch.object(ec2_provider, "_deploying_machine") as own_network:
            ec2_provider._ec2_config()

        own_network.assert_not_called()

    def test_missing_keys_off_ec2_name_the_keys_and_the_file(self):
        del self.controller.config["ec2-pool"]

        with patch.object(ec2_provider, "_deploying_machine", return_value=None):
            with self.assertRaisesRegex(
                RuntimeError,
                "global_controller.yaml does not set ec2-pool: region, subnet_id, "
                "security_group_ids",
            ):
                ec2_provider._ec2_config()

    def test_metadata_is_read_with_an_imdsv2_token(self):
        answers = {
            "/api/token": "token-1",
            "/meta-data/instance-id": "i-own",
            "/meta-data/mac": "0a:1b",
            "/meta-data/placement/region": "eu-west-1",
            "/meta-data/network/interfaces/macs/0a:1b/subnet-id": "subnet-own",
            "/meta-data/network/interfaces/macs/0a:1b/security-group-ids": (
                "sg-own-1\nsg-own-2"
            ),
        }
        tokens = []

        def urlopen(request, timeout):
            path = request.full_url.removeprefix(ec2_provider.METADATA_URL)
            if path != "/api/token":
                tokens.append(request.get_header("X-aws-ec2-metadata-token"))
            response = MagicMock()
            response.__enter__.return_value.read.return_value = answers[path].encode()
            return response

        with patch.object(ec2_provider.urllib.request, "urlopen", urlopen):
            self.assertEqual(
                ec2_provider._deploying_machine(),
                {"machine_id": "i-own", **self.OWN_NETWORK},
            )

        self.assertEqual(set(tokens), {"token-1"})

    def test_unreachable_metadata_is_asked_again_after_a_while(self):
        with patch.object(
            ec2_provider.urllib.request, "urlopen", side_effect=OSError("timed out")
        ) as urlopen:
            self.assertIsNone(ec2_provider._deploying_machine())
            # Launches right after don't each wait for it.
            self.assertIsNone(ec2_provider._deploying_machine())
            self.assertEqual(urlopen.call_count, 1)

            ec2_provider._own_machine_failed_at -= ec2_provider.METADATA_RETRY_SECONDS
            self.assertIsNone(ec2_provider._deploying_machine())

        self.assertEqual(urlopen.call_count, 2)


class RenamedProviderTests(unittest.TestCase):
    def test_a_machine_record_from_before_the_rename_still_finds_its_provider(self):
        from canyonos_core.reconciler import providers

        self.assertIs(providers.get("EC2"), ec2_provider)
        with self.assertRaises(ValueError):
            providers.canonical_name("EC2")

    def test_a_stored_name_in_any_spelling_finds_its_schema(self):
        from canyonos_core.reconciler import providers

        pool = providers.SCHEMAS["ec2-pool"]
        for stored in ("EC2", "EC2-pool", "ec2-pool"):
            self.assertIs(providers.schema(stored), pool)
        with self.assertRaises(ValueError):
            providers.schema("aws")
