# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Bug E: an agent container's CANYONOS_PROJECT_ID env var is frozen at launch.
_write_identity() publishes the controller's current project identity to every machine's Redis
(mirroring the existing policy:rules/routing_table:* pattern) so consumers can read it live
instead of trusting a boot-time env var. reload_config() must call this too, or the fix is
only half-applied.
"""

import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from canyonos_core.controller.global_controller import GlobalController
from fakes import _FakeRedis


def _bare_controller(config, machine_redis=None):
    controller = GlobalController.__new__(GlobalController)
    controller.config = config
    controller.redis = _FakeRedis()
    controller.machine_redis = machine_redis if machine_redis is not None else {}
    controller._set_agent_specs(config.get("agents", []))
    return controller


class WriteIdentityTests(unittest.TestCase):
    def setUp(self):
        patcher = patch.dict(os.environ, {}, clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_publishes_the_project_name_from_the_deploy_environment(self):
        controller = _bare_controller(
            {"project_id": "11111111-1111-1111-1111-111111111111"}
        )

        with patch.dict(os.environ, {"CANYONOS_PROJECT_NAME": "portfolio_agent"}):
            controller._write_identity()

        self.assertEqual(
            controller.redis.hgetall(GlobalController.IDENTITY_KEY)["project_name"],
            "portfolio_agent",
        )

    def test_publishes_project_id_to_self_redis_when_no_machine_redis(self):
        controller = _bare_controller(
            {"project_id": "11111111-1111-1111-1111-111111111111"}
        )

        controller._write_identity()

        self.assertEqual(
            controller.redis.hgetall(GlobalController.IDENTITY_KEY),
            {
                "project_id": "11111111-1111-1111-1111-111111111111",
                "project_name": "",
            },
        )

    def test_publishes_to_every_machine_not_just_self_redis(self):
        """The same lesson as Bug D: an agent replica on a remote EC2 host has its own
        Redis, distinct from the controller's local one. Publishing to self.redis alone
        would leave that replica reading nothing."""
        machine_a = _FakeRedis()
        machine_b = _FakeRedis()
        controller = _bare_controller(
            {"project_id": "11111111-1111-1111-1111-111111111111"},
            machine_redis={"localhost": machine_a, "172.31.0.5": machine_b},
        )

        controller._write_identity()

        for machine in (machine_a, machine_b):
            self.assertEqual(
                machine.hgetall(GlobalController.IDENTITY_KEY)["project_id"],
                "11111111-1111-1111-1111-111111111111",
            )

    def test_a_second_call_with_a_new_config_overwrites_the_published_value(self):
        """Simulates what reload_config() does on a real SIGHUP: the same key must reflect
        the *new* project after a switch, not just get set once at boot."""
        machine = _FakeRedis()
        controller = _bare_controller(
            {"project_id": "11111111-1111-1111-1111-111111111111"},
            machine_redis={"localhost": machine},
        )
        controller._write_identity()

        controller.config = {"project_id": "22222222-2222-2222-2222-222222222222"}
        controller._write_identity()

        self.assertEqual(
            machine.hgetall(GlobalController.IDENTITY_KEY),
            {
                "project_id": "22222222-2222-2222-2222-222222222222",
                "project_name": "",
            },
        )


if __name__ == "__main__":
    unittest.main()
