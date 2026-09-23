"""Both processes must resolve the config identically, or an unexpanded ${VAR} reaches AWS."""

import os
import shutil
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


if __name__ == "__main__":
    unittest.main()
