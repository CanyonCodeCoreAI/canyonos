"""Regressions for three independent defects found reviewing the CAN-316 diff."""

import os
import subprocess
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from canyonos_core.reconciler import providers
from canyonos_core.controller.local_controller import LocalController


class AgentStartupOrderTests(unittest.TestCase):
    def test_the_agent_is_constructed_after_the_llm_gateway_is_listening(self):
        """An agent constructor may build an LLM client against the in-container
        gateway, so the gateway has to exist first."""
        order = []

        with (
            patch.dict(
                os.environ,
                {"CANYONOS_AGENT_NAME": "Analyst", "CANYONOS_AGENT_PORT": "50051"},
            ),
            patch(
                "canyonos_core.controller.local_controller.start_server",
                return_value=(MagicMock(), MagicMock()),
            ),
            patch(
                "canyonos_core.controller.local_controller.RedisClient",
                return_value=MagicMock(),
            ),
            patch.object(
                LocalController,
                "_start_llm_gateway",
                lambda _self, *_a: order.append("gateway") or MagicMock(),
            ),
            patch.object(
                LocalController,
                "_load_agent",
                lambda _self: order.append("agent") or MagicMock(),
            ),
        ):
            LocalController()

        self.assertEqual(order, ["gateway", "agent"])


class RuntimeReuseScanTests(unittest.TestCase):
    def _bind(self, run_cmd):
        providers.bind(SimpleNamespace(config={}, _run_cmd=run_cmd))

    def test_an_unreachable_host_is_not_reusable_rather_than_fatal(self):
        def run_cmd(_cmd, host, user=None):
            raise RuntimeError(
                f"Command timed out after 180s on {host}: docker inspect"
            )

        self._bind(run_cmd)
        instance = {
            "runtime_id": "canyonos-agent-0",
            "private_host": "10.0.0.5",
            "provider": "EC2",
        }

        with self.assertLogs(
            "canyonos_core.reconciler.providers.shared_utils.docker_host",
            level="WARNING",
        ):
            self.assertFalse(providers.get("EC2").is_running(instance))

    def test_a_running_runtime_is_still_reported_as_reusable(self):
        def run_cmd(_cmd, _host, user=None):
            return subprocess.CompletedProcess([], 0, "true\n", "")

        self._bind(run_cmd)
        instance = {
            "runtime_id": "canyonos-agent-0",
            "private_host": "localhost",
            "provider": "local",
        }

        self.assertTrue(providers.get("local").is_running(instance))


if __name__ == "__main__":
    unittest.main()
