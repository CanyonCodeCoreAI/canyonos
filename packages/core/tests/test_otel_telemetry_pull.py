# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Covers the telemetry feed in controller/utils/otel_writer.py: ``_pull_telemetry`` (scan
future:* hashes from a machine's Redis) and ``send_telemetry`` (pull + queue into the
``traces_waiting`` table). Replaces the old test_telemetry_logging.py now that the legacy
Postgres writers are gone.
"""

import fnmatch
import os
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from canyonos_core.controller.utils import schema
from canyonos_core.controller.utils.otel_writer import (
    _pull_telemetry,
    deliver_completed_requests,
    send_telemetry,
)


class _FakeRedis:
    def __init__(self, hashes):
        self.hashes = hashes
        self.strings = {}

    def scan_keys(self, pattern):
        return [k for k in self.hashes if fnmatch.fnmatch(k, pattern)]

    def hgetall(self, name):
        return dict(self.hashes.get(name, {}))

    def get(self, name):
        if name in self.strings:
            return self.strings[name]
        return self.hashes.get(name)

    def set(self, name, value, nx=False):
        if nx and name in self.strings:
            return False
        self.strings[name] = value
        return True

    def smembers(self, name):
        return self.hashes.get(name, set())


class PullTelemetryTests(unittest.TestCase):
    def test_skips_children_and_consumers_and_stamps_future_id(self):
        redis = _FakeRedis(
            {
                "future:abc": {"id": "abc", "request_id": "req1"},
                "future:noid": {"request_id": "req2"},  # future_id falls back to key
                "future:abc:children": {"y": "1"},  # skipped
                "future:abc:consumers": {"x": "1"},  # skipped
            }
        )
        rows = _pull_telemetry(redis)
        by_id = {r["future_id"]: r for r in rows}
        self.assertEqual(set(by_id), {"abc", "noid"})
        self.assertEqual(by_id["noid"]["future_id"], "noid")


class SendTelemetryTests(unittest.TestCase):
    def setUp(self):
        fd, self.tmp = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        schema.init_db(self.tmp)

    def tearDown(self):
        if os.path.exists(self.tmp):
            os.remove(self.tmp)

    def _waiting(self):
        with sqlite3.connect(self.tmp) as conn:
            return {
                r[0]: r[1]
                for r in conn.execute(
                    "SELECT future_id, session_id FROM traces_waiting"
                )
            }

    def test_queues_rows_including_in_flight_futures(self):
        redis = _FakeRedis(
            {
                "future:done": {
                    "id": "done",
                    "request_id": "req1",
                    "agent": "a1",
                    "created_at": "1.0",
                    "finished_at": "9.0",
                },
                # In-flight (no finished_at) -- kept in `traces_waiting`, unlike the old
                # runtime_information writer that skipped unfinished rows.
                "future:live": {
                    "id": "live",
                    "request_id": "req2",
                    "created_at": "5.0",
                },
                "request:req1:futures": {"done"},
                "request:req2:futures": {"live"},
            }
        )
        send_telemetry(redis, project_id="proj-1", db_path=self.tmp)
        self.assertEqual(self._waiting(), {"done": "req1", "live": "req2"})

    def test_row_missing_request_id_is_dropped(self):
        redis = _FakeRedis({"future:orphan": {"id": "orphan"}})
        send_telemetry(redis, project_id="proj-1", db_path=self.tmp)
        self.assertEqual(self._waiting(), {})

    def test_terminal_trace_is_not_overwritten_by_stale_inflight_copy(self):
        redis = _FakeRedis(
            {
                "future:done": {
                    "id": "done",
                    "request_id": "req1",
                    "created_at": "1.0",
                    "finished_at": "9.0",
                },
            }
        )

        send_telemetry(redis, db_path=self.tmp)

        # A later poll receives a stale copy from another machine.
        stale = _FakeRedis(
            {
                "future:done": {
                    "id": "done",
                    "request_id": "req1",
                    "created_at": "1.0",
                },
            }
        )

        send_telemetry(stale, db_path=self.tmp)

        with sqlite3.connect(self.tmp) as conn:
            finished_at, failed = conn.execute(
                "SELECT finished_at, failed FROM traces_waiting WHERE future_id = ?",
                ("done",),
            ).fetchone()

        self.assertEqual(finished_at, 9.0)
        self.assertEqual(failed, 0)

    def test_marks_finished_requests_after_sqlite_writes(self):
        redis = _FakeRedis(
            {
                "future:done": {
                    "id": "done",
                    "request_id": "req1",
                    "created_at": "1.0",
                    "finished_at": "9.0",
                },
                "future:live": {
                    "id": "live",
                    "request_id": "req2",
                    "created_at": "5.0",
                },
                "request:req1:futures": {"done"},
                "request:req2:futures": {"live"},
            }
        )

        deliver_completed_requests(
            [redis], {"req1", "req2"}, project_id="proj-1", db_path=self.tmp
        )

        self.assertEqual(redis.get("telemetry:delivered:req1"), "1")
        self.assertIsNone(redis.get("telemetry:delivered:req2"))

    def test_acknowledges_terminal_futures_across_machines(self):
        origin = _FakeRedis(
            {
                "future:root": {
                    "id": "root",
                    "request_id": "req1",
                    "created_at": "1.0",
                    "finished_at": "9.0",
                },
                "request:req1:futures": {"root"},
            }
        )
        worker = _FakeRedis(
            {
                "future:child": {
                    "id": "child",
                    "request_id": "req1",
                    "created_at": "2.0",
                    "failed": "1",
                },
                "request:req1:futures": {"child"},
            }
        )

        deliver_completed_requests(
            [origin, worker], {"req1"}, project_id="proj-1", db_path=self.tmp
        )

        self.assertEqual(origin.get("telemetry:delivered:req1"), "1")
        self.assertEqual(worker.get("telemetry:delivered:req1"), "1")

    def test_does_not_acknowledge_a_future_missing_from_the_final_sweep(self):
        redis = _FakeRedis(
            {
                "future:root": {
                    "id": "root",
                    "request_id": "req1",
                    "created_at": "1.0",
                    "finished_at": "9.0",
                },
                "request:req1:futures": {"root", "child"},
            }
        )

        delivered, gone = deliver_completed_requests(
            [redis], {"req1"}, project_id="proj-1", db_path=self.tmp
        )

        self.assertEqual(delivered, set())
        self.assertEqual(gone, set())
        self.assertIsNone(redis.get("telemetry:delivered:req1"))

    def test_a_request_whose_futures_already_expired_is_gone_not_delivered(self):
        # Cleanup already ran and the grace period elapsed: nothing is left to
        # export or clean, so the GC can drain it without marking it again.
        redis = _FakeRedis({})

        delivered, gone = deliver_completed_requests(
            [redis], {"req1"}, project_id="proj-1", db_path=self.tmp
        )

        self.assertEqual(delivered, set())
        self.assertEqual(gone, {"req1"})
        self.assertIsNone(redis.get("telemetry:delivered:req1"))

    def test_an_existing_marker_is_not_overwritten(self):
        # A plain SET would drop the expiry cleanup gave the marker, leaving it to
        # outlive the request.
        redis = _FakeRedis(
            {
                "future:root": {
                    "id": "root",
                    "request_id": "req1",
                    "created_at": "1.0",
                    "finished_at": "9.0",
                },
                "request:req1:futures": {"root"},
            }
        )
        redis.strings["telemetry:delivered:req1"] = "expiring"

        delivered, _ = deliver_completed_requests(
            [redis], {"req1"}, project_id="proj-1", db_path=self.tmp
        )

        self.assertEqual(delivered, {"req1"})
        self.assertEqual(redis.get("telemetry:delivered:req1"), "expiring")


class _CountingRedis(_FakeRedis):
    """Records which future hashes are read."""

    def __init__(self, hashes):
        super().__init__(hashes)
        self.read = []

    def hgetall(self, name):
        self.read.append(name)
        return super().hgetall(name)


def _future(future_id, request_id, finished=True):
    row = {"id": future_id, "request_id": request_id, "created_at": "1.0"}
    if finished:
        row["finished_at"] = "2.0"
    return row


class ReadOnlyWhatIsNeededTests(unittest.TestCase):
    """A poll used to read every future in Redis, twice (telemetry and delivery)."""

    def setUp(self):
        self.tmp = os.path.join(tempfile.mkdtemp(), "q.db")
        schema.init_db(self.tmp)

    def test_a_finished_future_is_not_read_again_on_later_polls(self):
        redis = _CountingRedis(
            {
                "future:a": _future("a", "r1"),
                "future:b": _future("b", "r1", finished=False),
            }
        )
        finished = set()
        send_telemetry(redis, db_path=self.tmp, finished=finished)
        redis.read.clear()

        send_telemetry(redis, db_path=self.tmp, finished=finished)

        self.assertEqual(redis.read, ["future:b"])
        self.assertEqual(finished, {"a"})

    def test_a_failed_future_is_read_again_until_its_finished_at_is_written(self):
        # A failure writes `failed` first; `finished_at`, CPU and timing come a moment
        # later, and a future skipped in between would never get them.
        row = _future("a", "r1", finished=False)
        row["failed"] = "1"
        redis = _CountingRedis({"future:a": row})
        finished = set()
        send_telemetry(redis, db_path=self.tmp, finished=finished)
        self.assertEqual(finished, set())

        row["finished_at"] = "2.0"
        redis.read.clear()
        send_telemetry(redis, db_path=self.tmp, finished=finished)

        self.assertEqual(redis.read, ["future:a"])
        self.assertEqual(finished, {"a"})

    def test_finished_futures_that_expired_are_forgotten(self):
        redis = _CountingRedis({"future:a": _future("a", "r1")})
        finished = set()
        send_telemetry(redis, db_path=self.tmp, finished=finished)
        del redis.hashes["future:a"]

        send_telemetry(redis, db_path=self.tmp, finished=finished)

        self.assertEqual(finished, set())

    def test_delivery_reads_only_the_completed_requests_futures(self):
        redis = _CountingRedis(
            {
                "future:a": _future("a", "r1"),
                "future:other": _future("other", "r2", finished=False),
                "request:r1:futures": {"a"},
            }
        )

        delivered, _ = deliver_completed_requests([redis], {"r1"}, db_path=self.tmp)

        self.assertEqual(delivered, {"r1"})
        self.assertEqual(redis.read, ["future:a"])

    def test_a_request_marked_on_every_node_is_not_read_again(self):
        redis = _CountingRedis(
            {"future:a": _future("a", "r1"), "request:r1:futures": {"a"}}
        )
        redis.strings["telemetry:delivered:r1"] = "1"

        delivered, gone = deliver_completed_requests([redis], {"r1"}, db_path=self.tmp)

        self.assertEqual((delivered, gone), ({"r1"}, set()))
        self.assertEqual(redis.read, [])

    def test_a_future_added_while_reading_holds_its_request_back(self):
        redis = _CountingRedis(
            {"future:a": _future("a", "r1"), "request:r1:futures": {"a"}}
        )
        original = redis.hgetall

        def hgetall(name):
            # A new future of r1 appears just as its known ones are read.
            redis.hashes["request:r1:futures"] = {"a", "late"}
            return original(name)

        redis.hgetall = hgetall

        delivered, _ = deliver_completed_requests([redis], {"r1"}, db_path=self.tmp)

        self.assertEqual(delivered, set())


if __name__ == "__main__":
    unittest.main()
