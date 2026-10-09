import contextvars
import json
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest

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

    def test_request_context_lists_every_context_var(self):
        context_vars = {
            value
            for value in vars(canyonos_context).values()
            if isinstance(value, contextvars.ContextVar)
        }
        self.assertEqual(set(canyonos_context.REQUEST_CONTEXT), context_vars)


CORE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

# Run in a fresh interpreter so install() never patches the test runner's own Python.
INSTALLED_PROBE = """
import contextvars
import decimal
import json
import multiprocessing
import sys
import threading
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor

sys.path.insert(0, %r)
import canyonos_core.controller.canyonos_context as canyonos_context


def seen(_=None):
    return [
        canyonos_context.get_request_id(),
        canyonos_context.get_current_future_id(),
        canyonos_context.get_current_function(),
        canyonos_context.get_current_metrics_key(),
    ]


def set_request(n):
    canyonos_context.set_request_id(f"req-{n}")
    canyonos_context.set_current_future_id(f"future-{n}")
    canyonos_context.set_current_function("main")
    canyonos_context.set_current_metrics_key(f"metrics-{n}")


def in_thread(func):
    out = []
    thread = threading.Thread(target=lambda: out.append(func()))
    thread.start()
    thread.join()
    return out[0]


def child_sets_precision():
    decimal.getcontext().prec = 3
    return decimal.getcontext().prec


MARK = contextvars.ContextVar("mark", default="unset")


if __name__ == "__main__":
    canyonos_context.install()
    canyonos_context.install()
    results = {}
    decimal.getcontext().prec = 10
    results["child_prec"] = in_thread(child_sets_precision)
    with ThreadPoolExecutor(1) as pool:
        pool.submit(child_sets_precision).result()
    results["parent_prec"] = decimal.getcontext().prec
    with ThreadPoolExecutor(1, initializer=lambda: MARK.set("initialized")) as pool:
        results["initializer_value"] = pool.submit(MARK.get).result()

    set_request(1)
    results["thread"] = in_thread(seen)
    with ThreadPoolExecutor(1) as pool:
        results["thread_pool"] = pool.submit(seen).result()
    with ProcessPoolExecutor(1) as pool:
        results["process_pool"] = pool.submit(seen).result()
        set_request(2)
        results["process_pool_reused"] = pool.submit(seen).result()
    with multiprocessing.Pool(1) as pool:
        results["pool_apply"] = pool.apply(seen)
        results["pool_map"] = pool.map(seen, [0])[0]
        results["pool_imap"] = next(pool.imap(seen, [0]))
        results["pool_imap_unordered"] = next(pool.imap_unordered(seen, [0]))
    print(json.dumps(results))
"""

PLAIN_PROBE = """
import multiprocessing
from concurrent.futures import ProcessPoolExecutor


def square(x):
    return x * x


if __name__ == "__main__":
    with ProcessPoolExecutor(1) as pool:
        executor_result = pool.submit(square, 3).result()
    with multiprocessing.Pool(1) as pool:
        pool_result = pool.map(square, [4])[0]
    print(executor_result, pool_result)
"""


def _run_probe(source, *python_flags):
    with tempfile.TemporaryDirectory() as tmpdir:
        probe = os.path.join(tmpdir, "probe.py")
        with open(probe, "w") as f:
            f.write(textwrap.dedent(source))
        return subprocess.run(
            [sys.executable, *python_flags, probe],
            cwd=tmpdir,
            capture_output=True,
            text=True,
            timeout=120,
            check=True,
        ).stdout


class InstallTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.results = json.loads(_run_probe(INSTALLED_PROBE % CORE_DIR))

    def test_decimal_precision_stays_per_thread(self):
        self.assertEqual(self.results["child_prec"], 3)
        self.assertEqual(self.results["parent_prec"], 10)

    def test_a_thread_pool_initializer_value_reaches_its_tasks(self):
        self.assertEqual(self.results["initializer_value"], "initialized")

    def test_the_request_context_reaches_threads_and_pool_tasks(self):
        expected = ["req-1", "future-1", "main", "metrics-1"]
        for caller in (
            "thread",
            "thread_pool",
            "process_pool",
        ):
            with self.subTest(caller=caller):
                self.assertEqual(self.results[caller], expected)

    def test_a_reused_process_pool_worker_switches_request(self):
        self.assertEqual(
            self.results["process_pool_reused"],
            ["req-2", "future-2", "main", "metrics-2"],
        )

    def test_the_request_context_reaches_multiprocessing_pool_tasks(self):
        expected = ["req-2", "future-2", "main", "metrics-2"]
        for caller in ("pool_apply", "pool_map", "pool_imap", "pool_imap_unordered"):
            with self.subTest(caller=caller):
                self.assertEqual(self.results[caller], expected)

    def test_process_pools_work_in_a_process_without_canyonos(self):
        self.assertEqual(_run_probe(PLAIN_PROBE, "-I").split(), ["9", "16"])


if __name__ == "__main__":
    unittest.main()
