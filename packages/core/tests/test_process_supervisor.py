import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from canyonos_core.controller.utils.process_supervisor import ProcessSupervisor

# A child that lives long enough to be observed but never outlasts the test run.
_SLEEP_ARGV = [sys.executable, "-c", "import time; time.sleep(30)"]
_EXIT_ARGV = [sys.executable, "-c", ""]


class ProcessSupervisorTests(unittest.TestCase):
    def setUp(self):
        self.supervisor = ProcessSupervisor()
        self.addCleanup(self.supervisor.terminate_all, 5)

    def test_register_and_start_all_spawns_each_process(self):
        self.supervisor.register("a", _SLEEP_ARGV)
        self.supervisor.register("b", _SLEEP_ARGV)

        self.supervisor.start_all()

        self.assertEqual(set(self.supervisor._procs), {"a", "b"})
        pids = {name: p.pid for name, p in self.supervisor._procs.items()}

        self.supervisor.check_and_respawn()

        for name, proc in self.supervisor._procs.items():
            self.assertIsNone(proc.poll())
            self.assertEqual(proc.pid, pids[name])

    def test_check_and_respawn_restarts_an_exited_process_with_a_new_pid(self):
        self.supervisor.register("dies", _EXIT_ARGV)
        self.supervisor.start_all()
        first = self.supervisor._procs["dies"]
        first.wait(timeout=10)

        self.supervisor.check_and_respawn()

        second = self.supervisor._procs["dies"]
        self.assertNotEqual(second.pid, first.pid)
        second.wait(timeout=10)

    def test_terminate_all_stops_everything_and_clears_the_registry(self):
        self.supervisor.register("a", _SLEEP_ARGV)
        self.supervisor.register("b", _SLEEP_ARGV)
        self.supervisor.start_all()
        procs = list(self.supervisor._procs.values())

        self.supervisor.terminate_all(timeout=5)

        self.assertEqual(self.supervisor._procs, {})
        for proc in procs:
            self.assertIsNotNone(proc.poll())

    def test_register_env_merges_on_top_of_os_environ(self):
        self.supervisor.register(
            "env", _SLEEP_ARGV, env={"CANYONOS_TEST_MARKER": "set"}
        )

        with patch(
            "canyonos_core.controller.utils.process_supervisor.subprocess.Popen"
        ) as popen:
            self.supervisor.start_all()

        child_env = popen.call_args.kwargs["env"]
        self.assertEqual(child_env["CANYONOS_TEST_MARKER"], "set")
        self.assertEqual(child_env["PATH"], os.environ["PATH"])
        self.assertNotIn("CANYONOS_TEST_MARKER", os.environ)


if __name__ == "__main__":
    unittest.main()
