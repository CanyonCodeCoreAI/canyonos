# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""The global controller queues futures' telemetry once per machine's Redis per poll.

Telemetry lives in a machine's Redis, not in a replica. Pulled once per replica, every
replica on a machine scanned and queued the same futures again on each poll.
"""

import os
import sys
import threading
import time
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from canyonos_core.controller.global_controller import GlobalController


def _controller(machine_redis):
    controller = GlobalController.__new__(GlobalController)
    controller.config = {"project_id": "p1"}
    controller.machine_redis = machine_redis
    return controller


class TelemetryPollTests(unittest.TestCase):
    def test_each_machine_redis_is_pulled_once_with_its_own_finished_set(self):
        machines = {"10.0.0.1": MagicMock(name="a"), "10.0.0.2": MagicMock(name="b")}
        controller = _controller(machines)

        with patch("canyonos_core.controller.global_controller.send_telemetry") as send:
            controller._send_telemetry_per_host()

        self.assertCountEqual(
            [call.args[0] for call in send.call_args_list], list(machines.values())
        )
        sets = [call.kwargs["finished"] for call in send.call_args_list]
        self.assertIsNot(sets[0], sets[1])

    def test_machines_are_read_in_parallel(self):
        machines = {f"10.0.0.{i}": MagicMock() for i in range(3)}
        controller = _controller(machines)
        running, most = set(), []
        lock = threading.Lock()

        def slow_send(redis, project_id, finished):
            with lock:
                running.add(id(redis))
                most.append(len(running))
            time.sleep(0.2)
            with lock:
                running.discard(id(redis))

        with patch(
            "canyonos_core.controller.global_controller.send_telemetry",
            side_effect=slow_send,
        ):
            started = time.monotonic()
            controller._send_telemetry_per_host()

        self.assertEqual(max(most), 3)
        self.assertLess(time.monotonic() - started, 0.5)

    def test_a_failing_redis_does_not_stop_the_others(self):
        good, bad = MagicMock(name="good"), MagicMock(name="bad")
        controller = _controller({"bad": bad, "good": good})

        def send(redis, project_id, finished):
            if redis is bad:
                raise ConnectionError("down")

        with (
            patch(
                "canyonos_core.controller.global_controller.send_telemetry",
                side_effect=send,
            ) as sent,
            self.assertLogs(level="WARNING") as logs,
        ):
            controller._send_telemetry_per_host()

        self.assertEqual(sent.call_count, 2)
        self.assertIn("host bad", logs.output[0])

    def test_a_machine_that_is_gone_forgets_its_finished_set(self):
        controller = _controller({"a": MagicMock(), "b": MagicMock()})
        with patch("canyonos_core.controller.global_controller.send_telemetry"):
            controller._send_telemetry_per_host()
            del controller.machine_redis["b"]
            controller._send_telemetry_per_host()

        self.assertEqual(set(controller._finished_futures), {"a"})


if __name__ == "__main__":
    unittest.main()
