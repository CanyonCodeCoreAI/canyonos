# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Which port the Global Controller publishes for an endpoint whose config sets no
`api_port`: the one its container already got on a reload, else the one it had last
deploy, which the CLI passes in, else 8080. The reconciler moves on from there when
Docker finds the port taken."""

import os
import sys
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from canyonos_core.controller import global_controller
from canyonos_core.controller.global_controller import GlobalController


def _published_port(published=None, **environment):
    controller = GlobalController.__new__(GlobalController)
    controller.agent_specs = []
    controller.redis = MagicMock()
    for method in ("_apply_configured_replicas", "_write_policies", "_write_identity"):
        setattr(controller, method, MagicMock())
    endpoint_record = MagicMock(return_value={"arguments": []})
    with (
        patch.dict(os.environ, environment),
        patch.object(global_controller, "write_config_specs"),
        patch.object(global_controller, "read_endpoint_record", return_value=published),
        patch.object(global_controller, "endpoint_record", endpoint_record),
    ):
        controller._apply_config([], "manifest")
    return endpoint_record.call_args.args[1]


class EndpointPortTests(unittest.TestCase):
    def test_a_reload_keeps_the_port_the_endpoint_already_got(self):
        self.assertEqual(
            _published_port({"api_port": 8085}, CANYONOS_LAST_API_PORT="8091"), 8085
        )

    def test_a_deploy_starts_from_the_port_it_had_last_deploy(self):
        self.assertEqual(_published_port(CANYONOS_LAST_API_PORT="8091"), 8091)

    def test_a_first_deploy_starts_from_8080(self):
        self.assertEqual(_published_port(), 8080)


if __name__ == "__main__":
    unittest.main()
