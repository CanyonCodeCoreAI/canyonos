# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Waiting for work and results without polling.

Future.value() and a Future passed as an argument both read Redis every 10 ms, and
the local controller's loop woke every millisecond to look at an empty queue. A value
written in the same process now wakes its waiters at once, Redis is read again once a
second for one written elsewhere, and the loop sleeps until a request is queued.
"""

import os
import queue
import sys
import threading
import time
import unittest
from types import SimpleNamespace

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from canyonos_core.controller import future as future_module
from canyonos_core.controller.future import Future, notify_result, wait_for_result
from canyonos_core.controller.local_controller import LocalController


class _Redis:
    """Counts reads; the value appears when a test writes it."""

    def __init__(self):
        self.fields, self.reads = {}, 0

    def hget(self, key, field):
        self.reads += 1
        return self.fields.get(field)


def _in_thread(target):
    out = {}

    def run():
        try:
            out["value"] = target()
        except Exception as e:
            out["error"] = e

    thread = threading.Thread(target=run)
    thread.start()
    time.sleep(0.2)  # let it block
    return thread, out


class WaitForResultTests(unittest.TestCase):
    def test_a_value_written_in_this_process_wakes_its_waiter_at_once(self):
        redis = _Redis()
        thread, out = _in_thread(lambda: wait_for_result(redis, "f-1", timeout=5))

        started = time.monotonic()
        redis.fields["result"] = "done"
        notify_result("f-1")
        thread.join(2)

        self.assertEqual(out.get("value"), "done")
        self.assertLess(time.monotonic() - started, 0.5)
        # A few reads while it waited, not three every 10 ms.
        self.assertLess(redis.reads, 10)
        self.assertNotIn("f-1", future_module._result_waiters)

    def test_every_waiter_on_the_same_future_wakes(self):
        redis = _Redis()
        waits = [
            _in_thread(lambda: wait_for_result(redis, "f-2", timeout=5))
            for _ in range(3)
        ]

        redis.fields["result"] = "done"
        notify_result("f-2")
        for thread, _ in waits:
            thread.join(2)

        self.assertEqual([out.get("value") for _, out in waits], ["done"] * 3)
        self.assertNotIn("f-2", future_module._result_waiters)

    def test_a_value_written_elsewhere_is_found_by_the_recheck(self):
        redis = _Redis()
        thread, out = _in_thread(lambda: wait_for_result(redis, "f-3", timeout=5))

        redis.fields["result"] = "from another process"  # no notify
        thread.join(3)

        self.assertEqual(out.get("value"), "from another process")

    def test_a_failed_future_raises_its_error(self):
        redis = _Redis()
        redis.fields.update(failed="1", error="ValueError: bad input")
        with self.assertRaisesRegex(RuntimeError, "bad input"):
            wait_for_result(redis, "f-4", timeout=1)

    def test_a_timeout_raises_and_leaves_no_waiter(self):
        started = time.monotonic()
        with self.assertRaises(TimeoutError):
            wait_for_result(_Redis(), "f-5", timeout=0.3)
        self.assertLess(time.monotonic() - started, 1.0)
        self.assertNotIn("f-5", future_module._result_waiters)


class CallersTests(unittest.TestCase):
    def test_future_value_waits_through_it(self):
        redis = _Redis()
        future = SimpleNamespace(
            redis=redis, id="f-6", result=None, _key=lambda: "future:f-6"
        )
        thread, out = _in_thread(lambda: Future.value(future, timeout=5))

        redis.fields["result"] = "done"
        notify_result("f-6")
        thread.join(2)

        self.assertEqual(out.get("value"), "done")

    def test_a_future_argument_is_woken_instead_of_polled(self):
        redis = _Redis()
        controller = SimpleNamespace(redis=redis)
        thread, out = _in_thread(
            lambda: LocalController._resolve_future_args(
                controller, {"x": "f-7", "y": 2}, {"x"}, timeout=5
            )
        )

        redis.fields["result"] = "done"
        notify_result("f-7")
        thread.join(2)

        self.assertEqual(out.get("value"), {"x": "done", "y": 2})
        self.assertLess(redis.reads, 10)

    def test_a_future_argument_that_never_arrives_names_the_argument(self):
        controller = SimpleNamespace(redis=_Redis())
        with self.assertRaisesRegex(TimeoutError, "arg 'x'"):
            LocalController._resolve_future_args(
                controller, {"x": "f-8"}, {"x"}, timeout=0.2
            )


class ControllerLoopTests(unittest.TestCase):
    def test_the_loop_sleeps_on_the_queue_until_a_request_arrives(self):
        processed = []
        controller = SimpleNamespace(
            request_queue=queue.Queue(),
            _process_request=processed.append,
            _mark_future_failed=lambda *args: None,
            stop=lambda: None,
        )
        threading.Thread(
            target=LocalController.run, args=(controller,), daemon=True
        ).start()
        time.sleep(0.2)
        self.assertEqual(processed, [])

        controller.request_queue.put('{"future_id": "f-9"}')
        time.sleep(0.2)

        self.assertEqual(processed, [{"future_id": "f-9"}])


if __name__ == "__main__":
    unittest.main()
