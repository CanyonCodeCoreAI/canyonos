"""Both processes must resolve the config identically, or an unexpanded ${VAR} reaches AWS."""

import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from canyonos_core.controller.controller_context import ControllerContext
from canyonos_core.controller.global_controller import GlobalController

_CONFIG = """\
poll_interval: 5
ec2:
  region: ${TEST_EC2_REGION}
  ami_id: ${TEST_EC2_AMI_ID}
  security_group_ids:
    - ${TEST_EC2_SG}
agents:
  - name: Alpha
    provider: EC2
    replicas: 1
    instance_type: ${TEST_EC2_TYPE}
project_id: "fixed"
"""


class ConfigExpansionParityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        os.makedirs(os.path.join(self.tmp, "config"))
        self.config_path = os.path.join(self.tmp, "config", "global_controller.yaml")
        with open(self.config_path, "w") as f:
            f.write(_CONFIG)
        self.env = {
            "TEST_EC2_REGION": "us-east-2",
            "TEST_EC2_AMI_ID": "ami-0abc123",
            "TEST_EC2_SG": "sg-0def456",
            "TEST_EC2_TYPE": "t3.small",
        }

    def test_both_processes_expand_env_refs_identically(self):
        with patch.dict(os.environ, self.env):
            config = ControllerContext._load_config(self.config_path)
            self.assertEqual(config, GlobalController._load_config(self.config_path))

        self.assertEqual(config["ec2"]["ami_id"], "ami-0abc123")
        self.assertEqual(config["ec2"]["region"], "us-east-2")
        self.assertEqual(config["ec2"]["security_group_ids"], ["sg-0def456"])
        self.assertEqual(config["agents"][0]["instance_type"], "t3.small")

    def test_an_unset_ref_is_left_alone_rather_than_emptied(self):
        """A visible ${VAR} in a failure message beats a silently empty value."""
        with patch.dict(os.environ, self.env):
            del os.environ["TEST_EC2_AMI_ID"]
            config = ControllerContext._load_config(self.config_path)

        self.assertEqual(config["ec2"]["ami_id"], "${TEST_EC2_AMI_ID}")


class ReconcilerContextParityTests(unittest.TestCase):
    """The reconciler builds a bare ControllerContext, so it must match the GC on these."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        os.makedirs(os.path.join(self.tmp, "config"))
        self.env_file = os.path.join(self.tmp, "secrets.env")
        with open(self.env_file, "w") as f:
            f.write("API_KEY=abc\n")
        self.config_path = os.path.join(self.tmp, "config", "global_controller.yaml")
        with open(self.config_path, "w") as f:
            f.write(
                f"env_file: {self.env_file}\n"
                "agents:\n  - name: Alpha\n    host: localhost\n    replicas: 1\n"
            )

    def test_containerized_redis_host_override_reaches_the_context(self):
        with (
            patch.dict(os.environ, {"CANYONOS_REDIS_HOST": "host.docker.internal"}),
            patch(
                "canyonos_core.controller.controller_context.RedisClient"
            ) as redis_client,
        ):
            context = ControllerContext(self.config_path)
            context.attach_local_node_redis()

        hosts = [call.kwargs["host"] for call in redis_client.call_args_list]
        self.assertEqual(hosts, ["host.docker.internal", "host.docker.internal"])

    def _context(self):
        with patch("canyonos_core.controller.controller_context.RedisClient"):
            return ControllerContext(self.config_path)

    def test_context_carries_the_env_file(self):
        self.assertEqual(self._context().env_file_path, self.env_file)

    def test_refresh_env_file_picks_up_a_changed_path_and_keeps_the_old_on_error(self):
        context = self._context()
        other = os.path.join(self.tmp, "other.env")
        with open(other, "w") as f:
            f.write("API_KEY=xyz\n")
        with open(self.config_path, "w") as f:
            f.write(f"env_file: {other}\nagents: []\n")
        context.refresh_env_file()
        self.assertEqual(context.env_file_path, other)

        with open(self.config_path, "w") as f:
            f.write("env_file: /does/not/exist.env\nagents: []\n")
        context.refresh_env_file()
        self.assertEqual(context.env_file_path, other)


class PushFileTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.local = os.path.join(self.tmp, "secrets.env")
        with open(self.local, "w") as f:
            f.write("API_KEY=abc\n")
        self.context = ControllerContext.__new__(ControllerContext)
        self.context._ssh_args = lambda host, user=None: ["ssh", host]

    def _push(self, returncode=0, stdout="", stderr=""):
        result = subprocess.CompletedProcess([], returncode, stdout, stderr)
        with patch(
            "canyonos_core.controller.controller_context.subprocess.run",
            return_value=result,
        ) as run:
            path = self.context._push_file(self.local, "10.0.0.5")
        return path, run

    def test_copies_into_a_fresh_private_directory_and_returns_its_path(self):
        path, run = self._push(stdout="/tmp/canyonos.Ab12Cd34Ef/env")

        self.assertEqual(path, "/tmp/canyonos.Ab12Cd34Ef/env")
        remote_cmd = run.call_args.args[0][-1]
        self.assertTrue(remote_cmd.startswith("umask 077 && "))
        self.assertIn("mktemp -d", remote_cmd)
        self.assertEqual(run.call_args.args[0][:2], ["ssh", "10.0.0.5"])

    def test_a_failed_copy_raises_with_the_remote_error(self):
        with self.assertRaisesRegex(RuntimeError, "No space left"):
            self._push(returncode=1, stderr="No space left on device")

    def test_unexpected_output_is_rejected_before_it_can_reach_rm(self):
        for stdout in (
            "",
            "/",
            "/tmp",
            "welcome!\n/tmp/canyonos.x/env",
            "/tmp/../canyonos.x/env",
        ):
            with self.subTest(stdout=stdout):
                with self.assertRaisesRegex(RuntimeError, "unexpected path"):
                    self._push(stdout=stdout)


if __name__ == "__main__":
    unittest.main()
