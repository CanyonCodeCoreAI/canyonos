# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""The machine metrics collector runs the image the CLI handed the GC.

It used to default to a hardcoded published image that never contained the poller, so
the collector crash-looped on `No module named canyonos_core.machine_metrics_poller`
in every deployment while the GC itself reported success.
"""

import os
import subprocess
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from canyonos_core.controller import global_controller as gc_module
from canyonos_core.controller.global_controller import GlobalController
from canyonos_core.reconciler import machine_provisioner
from canyonos_core.reconciler.machine_provisioner import MachineProvisioner


def _bare_controller():
    controller = GlobalController.__new__(GlobalController)
    controller.config = {"poll_interval": 4, "redis": {"port": 6380}}
    controller.agent_specs = [
        {"name": "IntentAgent", "replicas": 1, "provider": "local"}
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


def _env(cmd):
    return dict(cmd[i + 1].split("=", 1) for i, a in enumerate(cmd) if a == "-e")


class OtherMachineCollectorTests(unittest.TestCase):
    """A machine the reconciler starts gets its own collector, from the official release
    image, writing to its own Redis under its own address."""

    def setUp(self):
        self.runs = []

        def run_cmd(cmd, host=None, user=None):
            self.runs.append((cmd, host, user))
            if cmd[:2] == ["docker", "inspect"]:
                return subprocess.CompletedProcess(cmd, 1, "", "No such object")
            return subprocess.CompletedProcess(cmd, 0, "deadbeef\n", "")

        self.controller = SimpleNamespace(
            config={"poll_interval": 4},
            agent_specs=[
                {"name": "Alpha", "resources": {"gpu": 1}},
                {"name": "Beta", "resources": {}},
            ],
            redis_ports={"10.0.0.7": 6390},
            _run_cmd=run_cmd,
        )
        self.provisioner = MachineProvisioner(self.controller)

    def _start(self, machine_spec, host="10.0.0.7"):
        self.provisioner._start_metrics_collector(
            machine_spec, {"private_host": host, "user": "ubuntu"}
        )
        return [run for run in self.runs if run[0][:2] == ["docker", "run"]]

    def test_it_runs_the_release_image_on_that_machine(self):
        with patch.object(machine_provisioner, "COLLECTOR_IMAGE", "ghcr.io/x/core:1.2"):
            ((cmd, host, user),) = self._start({"agent_name": "Beta"})

        self.assertEqual((host, user), ("10.0.0.7", "ubuntu"))
        self.assertEqual(
            cmd[cmd.index("ghcr.io/x/core:1.2") :],
            ["ghcr.io/x/core:1.2", "-m", "canyonos_core.machine_metrics_poller"],
        )
        self.assertEqual(_env(cmd)["CANYONOS_METRICS_KEY"], "machine:10.0.0.7:metrics")
        self.assertEqual(_env(cmd)["CANYONOS_REDIS_PORT"], "6390")
        # Beta's machine has no GPU agent on it.
        self.assertNotIn("--gpus", cmd)

    def test_a_gpu_agents_machine_gets_the_gpu(self):
        with patch.object(machine_provisioner, "COLLECTOR_IMAGE", "ghcr.io/x/core:1.2"):
            ((cmd, _host, _user),) = self._start({"agent_name": "Alpha"})

        self.assertIn("--gpus", cmd)

    def test_no_collector_without_the_release_image(self):
        with patch.object(machine_provisioner, "COLLECTOR_IMAGE", None):
            self.assertEqual(self._start({}), [])

    def test_this_machine_is_left_to_the_global_controller(self):
        with patch.object(machine_provisioner, "COLLECTOR_IMAGE", "ghcr.io/x/core:1.2"):
            self.assertEqual(self._start({}, host="localhost"), [])


class _Redis:
    def __init__(self, hashes, records=()):
        self.hashes = hashes
        self.records = {f"machine_record:{i}": r for i, r in enumerate(records)}

    def scan_keys(self, pattern):
        return list(self.records)

    def hget(self, key, field):
        return self.records[key].get(field)

    def hgetall(self, key):
        return self.hashes.get(key, {})


class PollMachineMetricsTests(unittest.TestCase):
    def test_every_machine_is_read_from_its_own_redis(self):
        controller = GlobalController.__new__(GlobalController)
        controller.config = {"project_id": "p1"}
        controller.redis_ports = {}
        controller.redis = _Redis(
            {"machine:localhost:metrics": {"cpu_percent": "5"}},
            # This machine's own record, one up machine, and one still starting.
            [{"private_host": "localhost"}, {"private_host": "10.0.0.7"}, {}],
        )
        remote = _Redis({"machine:10.0.0.7:metrics": {"cpu_percent": "60"}})
        controller.machine_redis_for_replica = lambda replica: remote
        written = []

        with patch.object(gc_module.otel_writer, "metric_write_rows", written.extend):
            controller._poll_machine_metrics()

        self.assertEqual(
            [(row["host"], row["metrics"]) for row in written],
            [("localhost", {"cpu_percent": "5"}), ("10.0.0.7", {"cpu_percent": "60"})],
        )


if __name__ == "__main__":
    unittest.main()
