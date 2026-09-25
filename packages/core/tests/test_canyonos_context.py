import contextvars
import os
import sys
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import canyonos_core.controller.canyonos_context as canyonos_context


class CanyonosContextTests(unittest.TestCase):
    def run(self, result=None):
        # Each test starts from an empty context, so values set in one never reach another.
        return contextvars.Context().run(super().run, result)

    def test_request_id_defaults_to_empty_string(self):
        self.assertEqual(canyonos_context.get_request_id(), "")

    def test_request_id_round_trips(self):
        canyonos_context.set_request_id("req-123")
        self.assertEqual(canyonos_context.get_request_id(), "req-123")

    def test_current_future_id_defaults_to_empty_string(self):
        self.assertEqual(canyonos_context.get_current_future_id(), "")

    def test_current_future_id_round_trips(self):
        canyonos_context.set_current_future_id("future-abc")
        self.assertEqual(canyonos_context.get_current_future_id(), "future-abc")

    def test_request_id_and_future_id_are_independent(self):
        canyonos_context.set_request_id("req-123")
        canyonos_context.set_current_future_id("future-abc")
        self.assertEqual(canyonos_context.get_request_id(), "req-123")
        self.assertEqual(canyonos_context.get_current_future_id(), "future-abc")

    def test_current_metrics_key_defaults_to_empty_string(self):
        self.assertEqual(canyonos_context.get_current_metrics_key(), "")

    def test_current_metrics_key_round_trips(self):
        canyonos_context.set_current_metrics_key("controller:localhost:50051:metrics")
        self.assertEqual(
            canyonos_context.get_current_metrics_key(),
            "controller:localhost:50051:metrics",
        )

    def _set_all(self):
        canyonos_context.set_request_id("req-123")
        canyonos_context.set_current_future_id("future-abc")
        canyonos_context.set_current_metrics_key("controller:localhost:50051:metrics")

    @staticmethod
    def _get_all():
        return (
            canyonos_context.get_request_id(),
            canyonos_context.get_current_future_id(),
            canyonos_context.get_current_metrics_key(),
        )

    def test_values_reach_worker_run_in_copied_context(self):
        self._set_all()
        ctx = contextvars.copy_context()
        with ThreadPoolExecutor(max_workers=1) as pool:
            seen = pool.submit(ctx.run, self._get_all).result()
        self.assertEqual(
            seen, ("req-123", "future-abc", "controller:localhost:50051:metrics")
        )

    def test_values_do_not_reach_bare_thread(self):
        self._set_all()
        seen = []
        worker = threading.Thread(target=lambda: seen.append(self._get_all()))
        worker.start()
        worker.join()
        self.assertEqual(seen, [("", "", "")])


if __name__ == "__main__":
    unittest.main()
