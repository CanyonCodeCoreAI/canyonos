# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

import os
import signal
import tempfile
import threading
import unittest
from unittest.mock import MagicMock, patch

from canyonos_core.controller import run_gc
from canyonos_core.controller.orchestrator import TARGET_ENV


class WaitForRedisTests(unittest.TestCase):
    def test_it_keeps_waiting_until_redis_answers_instead_of_failing(self):
        with (
            patch.object(run_gc, "RedisClient") as client,
            patch.object(
                run_gc,
                "_wait_for_redis",
                side_effect=[TimeoutError(), TimeoutError(), None],
            ) as wait,
        ):
            run_gc.wait_for_redis("canyonos-redis", 6379)

        client.assert_called_once_with(host="canyonos-redis", port=6379)
        self.assertEqual(wait.call_count, 3)


class ConfigFingerprintTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = tmp.name
        self._write("global_controller.yaml", "agents: []\n")

    def _write(self, name, text):
        with open(os.path.join(self.dir, name), "w") as f:
            f.write(text)

    def test_it_changes_with_a_files_content(self):
        before = run_gc.config_fingerprint(self.dir)
        self._write("global_controller.yaml", "agents: [x]\n")
        self.assertNotEqual(run_gc.config_fingerprint(self.dir), before)

    def test_configmap_bookkeeping_is_ignored(self):
        before = run_gc.config_fingerprint(self.dir)
        os.mkdir(os.path.join(self.dir, "..2026_10_14"))
        self._write("..data", "x")
        self.assertEqual(run_gc.config_fingerprint(self.dir), before)


class WatchConfigTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = tmp.name
        self.path = os.path.join(self.dir, "global_controller.yaml")
        with open(self.path, "w") as f:
            f.write("agents: []\n")
        self.controller = MagicMock()
        self.stop = threading.Event()
        self.addCleanup(self.stop.set)

        # Edits must land after the watcher's first read, or they are its baseline.
        first_read = threading.Event()
        fingerprint = run_gc.config_fingerprint

        def reading(config_dir):
            value = fingerprint(config_dir)
            first_read.set()
            return value

        patcher = patch.object(run_gc, "config_fingerprint", reading)
        patcher.start()
        self.addCleanup(patcher.stop)
        threading.Thread(
            target=run_gc.watch_config,
            args=(self.controller, self.dir, self.stop, 0.05),
            daemon=True,
        ).start()
        self.assertTrue(first_read.wait(5))

    def _wait_for(self, condition):
        for _ in range(250):
            if condition():
                return True
            threading.Event().wait(0.02)
        return False

    def test_a_changed_file_reloads_the_config(self):
        threading.Event().wait(0.15)
        self.controller.reload_config.assert_not_called()
        with open(self.path, "w") as f:
            f.write("agents: [x]\n")
        self.assertTrue(self._wait_for(lambda: self.controller.reload_config.called))

    def test_a_broken_edit_is_logged_and_the_watcher_keeps_going(self):
        self.controller.reload_config.side_effect = [ValueError("bad yaml"), None]
        with self.assertLogs("canyonos_core.controller.run_gc", "ERROR"):
            with open(self.path, "w") as f:
                f.write("agents: [\n")
            self.assertTrue(
                self._wait_for(lambda: self.controller.reload_config.call_count == 1)
            )
        with open(self.path, "w") as f:
            f.write("agents: [y]\n")
        self.assertTrue(
            self._wait_for(lambda: self.controller.reload_config.call_count == 2)
        )


class RunTests(unittest.TestCase):
    def test_it_refuses_to_run_outside_kubernetes(self):
        with patch.dict(os.environ):
            os.environ.pop(TARGET_ENV, None)
            with self.assertRaisesRegex(SystemExit, "CANYONOS_TARGET=kubernetes"):
                run_gc.run("config.yaml")

    def test_redis_first_then_the_controller_and_sigterm_stops_it(self):
        events = []
        controller = MagicMock()
        handlers = {}
        controller.run.side_effect = lambda: events.append("run")

        def build(_path):
            events.append("controller")
            return controller

        with (
            patch.dict(
                os.environ,
                {TARGET_ENV: "kubernetes", "CANYONOS_REDIS_HOST": "canyonos-redis"},
            ),
            patch.object(
                run_gc, "wait_for_redis", side_effect=lambda *a: events.append(a)
            ),
            patch(
                "canyonos_core.controller.global_controller.GlobalController",
                side_effect=build,
            ),
            patch.object(run_gc.signal, "signal", side_effect=handlers.__setitem__),
            patch.object(run_gc.threading, "Thread"),
        ):
            run_gc.run("/etc/canyonos/config/global_controller.yaml")

        self.assertEqual(events, [("canyonos-redis", 6379), "controller", "run"])
        self.assertNotIn(signal.SIGHUP, handlers)

        with self.assertRaises(SystemExit) as exited:
            handlers[signal.SIGTERM](signal.SIGTERM, None)
        self.assertEqual(exited.exception.code, 0)
        controller.cleanup.assert_called_once()


if __name__ == "__main__":
    unittest.main()
