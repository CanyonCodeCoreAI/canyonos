"""The machine metrics collector runs the image the CLI handed the GC.

It used to default to a hardcoded published image that never contained the poller, so
the collector crash-looped on `No module named canyonos_core.machine_metrics_poller`
in every deployment while the GC itself reported success.
"""

import os
import subprocess
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from canyonos_core.controller import global_controller as gc_module
from canyonos_core.controller.global_controller import GlobalController


def _bare_controller():
    controller = GlobalController.__new__(GlobalController)
    controller.config = {"poll_interval": 4}
    controller.controllers = [
        {"name": "IntentAgent", "replicas": 1, "redis_port": 6380, "provider": "local"}
    ]
    controller._metrics_collectors = {}
    controller.runs = []

    def _run_cmd(cmd, host=None, user=None):
        controller.runs.append(cmd)
        # No collector is already running, so the launcher proceeds to `docker run`.
        if cmd[:2] == ["docker", "inspect"]:
            return subprocess.CompletedProcess(cmd, 1, "", "No such object")
        return subprocess.CompletedProcess(cmd, 0, "deadbeef\n", "")

    controller._run_cmd = _run_cmd
    return controller


def _docker_run(controller):
    return next(cmd for cmd in controller.runs if cmd[:2] == ["docker", "run"])


class MetricsCollectorImageTests(unittest.TestCase):
    def test_the_collector_runs_the_image_the_cli_passed_in(self):
        controller = _bare_controller()

        with patch.object(gc_module, "CONTROLLER_IMAGE", "canyonos-core:dev"):
            controller._launch_metrics_collectors()

        cmd = _docker_run(controller)
        self.assertIn("canyonos-core:dev", cmd)
        # The image is the thing python runs the poller out of, so it must sit
        # directly before the `-m <module>` pair.
        self.assertEqual(
            cmd[cmd.index("canyonos-core:dev") + 1 :],
            ["-m", "canyonos_core.machine_metrics_poller"],
        )
        self.assertEqual(
            controller._metrics_collectors, {"localhost": "canyonos-metrics-localhost"}
        )

    def test_no_collector_is_launched_when_the_image_is_unset(self):
        # Better to report missing machine metrics than to silently run whatever
        # some hardcoded published tag happens to contain.
        controller = _bare_controller()

        with patch.object(gc_module, "CONTROLLER_IMAGE", None):
            controller._launch_metrics_collectors()

        self.assertEqual(controller.runs, [])
        self.assertEqual(controller._metrics_collectors, {})

    def test_the_collector_is_pointed_at_the_configured_redis_port(self):
        # The collector reaches Redis on the host's published port, which is not
        # always 6379.
        controller = _bare_controller()

        with patch.object(gc_module, "CONTROLLER_IMAGE", "canyonos-core:dev"):
            controller._launch_metrics_collectors()

        cmd = _docker_run(controller)
        env = dict(cmd[i + 1].split("=", 1) for i, a in enumerate(cmd) if a == "-e")
        self.assertEqual(env["CANYONOS_REDIS_PORT"], "6380")


if __name__ == "__main__":
    unittest.main()
