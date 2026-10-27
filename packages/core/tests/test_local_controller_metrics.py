# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

import os
import sys
import threading
import time
import unittest
import json
from unittest.mock import MagicMock
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
sys.path.insert(
    0,
    os.path.abspath(
        os.path.join(
            os.path.dirname(__file__), "..", "canyonos_core", "templates", "grpc_stubs"
        )
    ),
)

from canyonos_core.controller.local_controller import (
    LocalController,
)
from fakes import _FakeRedis


def _bind_failure_marker(controller):
    controller._cut_off = set()
    controller._mark_future_failed = lambda *a, **k: (
        LocalController._mark_future_failed(controller, *a, **k)
    )
    controller._send_result_callback = (
        lambda origin, future_id, result=None, failed=0, error_message="": (
            LocalController._send_result_callback(
                controller, origin, future_id, result, failed, error_message
            )
        )
    )
    controller._fan_out_to_consumers = (
        lambda future_id, result=None, failed=0, error_message="": (
            LocalController._fan_out_to_consumers(
                controller, future_id, result, failed, error_message
            )
        )
    )
    return controller


class LocalControllerMetricsTests(unittest.TestCase):
    def test_configured_agent_load_failure_never_reports_healthy(self):
        redis = _FakeRedis()
        server = MagicMock()
        gateway = MagicMock(**{"poll.return_value": None})
        servicer = SimpleNamespace(request_queue=None, on_result=None)
        controllers = []

        def capture_heartbeat_then_fail(controller):
            controllers.append(controller)
            return None

        with (
            patch.dict(
                os.environ,
                {
                    "CANYONOS_AGENT_NAME": "MissingAgent",
                    "CANYONOS_AGENT_FILE": "/definitely/missing-agent.py",
                },
            ),
            patch(
                "canyonos_core.controller.local_controller.start_server",
                return_value=(server, servicer),
            ),
            patch(
                "canyonos_core.controller.local_controller.RedisClient",
                return_value=redis,
            ),
            patch.object(LocalController, "_start_llm_gateway", return_value=gateway),
            patch.object(LocalController, "_load_agent", capture_heartbeat_then_fail),
        ):
            with self.assertRaisesRegex(
                RuntimeError, "Failed to load configured agent"
            ):
                LocalController()

        self.assertEqual(redis.get("controller:localhost:50051:status"), "failed")
        server.stop.assert_called_once_with(0)
        gateway.kill.assert_called_once_with()
        self.assertFalse(controllers[0]._metrics_thread.is_alive())

    def test_heartbeat_is_running_while_the_agent_loads(self):
        redis = _FakeRedis()
        servicer = SimpleNamespace(request_queue=None, on_result=None)
        seen_during_load = {}

        def load_agent(controller):
            seen_during_load["heartbeat_running"] = (
                controller._metrics_thread.is_alive()
            )
            seen_during_load["status"] = redis.get("controller:localhost:50051:status")
            seen_during_load["observed_at"] = redis.hget(
                "controller:localhost:50051:metrics", "observed_at"
            )
            return object()

        with (
            patch(
                "canyonos_core.controller.local_controller.start_server",
                return_value=(MagicMock(), servicer),
            ),
            patch(
                "canyonos_core.controller.local_controller.RedisClient",
                return_value=redis,
            ),
            patch.object(LocalController, "_start_llm_gateway", return_value=None),
            patch.object(LocalController, "_load_agent", load_agent),
        ):
            controller = LocalController()
        controller._metrics_stop_event.set()
        controller._metrics_thread.join(timeout=2)

        self.assertTrue(seen_during_load["heartbeat_running"])
        self.assertEqual(seen_during_load["status"], "initializing")
        self.assertIsNotNone(seen_during_load["observed_at"])

    def test_collect_metrics_returns_expected_keys(self):
        # Machine-level metrics (cpu/gpu/disk/memory/uptime) moved to the per-machine
        # collector container; _collect_metrics now reports only in-process replica
        # state that a sibling process can't observe.
        controller = SimpleNamespace(
            _executor=ThreadPoolExecutor(max_workers=1),
            _metrics_interval=5,
            _draining=True,
            servicer=SimpleNamespace(open_requests={"r1"}),
            request_queue=__import__("queue").Queue(),
            _unsent=1,
        )
        controller.request_queue.put("{}")
        metrics = LocalController._collect_metrics(controller)
        self.assertEqual(metrics["status"], "healthy")
        self.assertEqual(
            set(metrics.keys()),
            {
                "status",
                "queue_length",
                "draining",
                "open_requests",
                "pending_requests",
                "observed_at",
            },
        )
        self.assertEqual(metrics["pending_requests"], "2")
        int(metrics["queue_length"])
        float(metrics["observed_at"])
        self.assertEqual(metrics["draining"], "1")
        self.assertEqual(metrics["open_requests"], "1")

    def _run_one_metrics_tick(self, redis, ready, stateful=(), controller=None):
        stop_event = threading.Event()
        ready_event = threading.Event()
        if ready:
            ready_event.set()
        controller = controller or SimpleNamespace(
            redis=redis,
            agent_name="Alpha",
            _stateful=set(stateful),
            servicer=SimpleNamespace(refusing=False),
            _failed_leftovers=False,
            failed_leftovers=[],
            _metrics_key="controller:localhost:50051:metrics",
            _status_key="controller:localhost:50051:status",
            _draining_key="controller:localhost:50051:draining",
            _metrics_stop_event=stop_event,
            _metrics_interval=5,
            _ready=ready_event,
            _status_lock=threading.Lock(),
            _load_policy_rules=lambda reload=False: None,
        )
        controller._metrics_stop_event = stop_event
        controller._watch_llm_gateway = lambda: None
        controller._fail_unfinished = lambda: controller.failed_leftovers.append(True)
        controller._collect_metrics = lambda: {
            "status": "healthy",
            "queue_length": "3",
            "draining": str(int(controller._draining)),
            "observed_at": "100.0",
        }

        def stop_after_one_tick(timeout):
            stop_event.set()

        stop_event.wait = stop_after_one_tick

        LocalController._metrics_loop(controller)
        return controller

    def test_a_drain_flag_turns_new_work_away_before_the_heartbeat_reports_it(self):
        redis = _FakeRedis()
        redis.set("controller:localhost:50051:draining", str(time.time() + 180))

        controller = self._run_one_metrics_tick(redis, ready=True)

        self.assertTrue(controller.servicer.refusing)
        self.assertEqual(controller.failed_leftovers, [])
        self.assertEqual(
            redis.hgetall("controller:localhost:50051:metrics")["draining"], "1"
        )

    def test_a_draining_stateful_replica_keeps_taking_calls(self):
        redis = _FakeRedis()
        redis.set("controller:localhost:50051:draining", str(time.time() + 180))

        controller = self._run_one_metrics_tick(redis, ready=True, stateful={"Alpha"})

        self.assertFalse(controller.servicer.refusing)
        self.assertEqual(
            redis.hgetall("controller:localhost:50051:metrics")["draining"], "1"
        )

    def test_leftover_calls_are_failed_once_two_heartbeats_before_removal(self):
        redis = _FakeRedis()
        # Removal in 9 s is within two 5 s heartbeats.
        redis.set("controller:localhost:50051:draining", str(time.time() + 9))

        controller = self._run_one_metrics_tick(redis, ready=True)
        self._run_one_metrics_tick(redis, ready=True, controller=controller)

        self.assertEqual(controller.failed_leftovers, [True])

    def test_fail_unfinished_fails_running_and_queued_calls_back_to_their_callers(self):
        failed = []
        controller = SimpleNamespace(
            _my_address="10.0.0.1:50051",
            _executor_futures={
                object(): ("running", "10.0.0.9:50051", "Risk", "assess")
            },
            _executor_futures_lock=threading.Lock(),
            request_queue=__import__("queue").Queue(),
            _cut_off=set(),
            _mark_future_failed=lambda future_id, error, origin, error_name: (
                failed.append((future_id, origin, error, error_name))
            ),
        )
        controller.request_queue.put(
            json.dumps(
                {
                    "future_id": "queued",
                    "origin": "10.0.0.8:50051",
                    "service": "Price",
                    "function": "quote",
                }
            )
        )

        LocalController._fail_unfinished(controller)

        removed = "stopped before it finished: its replica was removed (scaled down or replaced)."
        self.assertEqual(
            sorted(failed),
            [
                (
                    "queued",
                    "10.0.0.8:50051",
                    f"Price.quote {removed}",
                    "ReplicaRemovedError",
                ),
                (
                    "running",
                    "10.0.0.9:50051",
                    f"Risk.assess {removed}",
                    "ReplicaRemovedError",
                ),
            ],
        )
        self.assertTrue(controller.request_queue.empty())
        self.assertEqual(controller.request_queue.unfinished_tasks, 0)
        self.assertEqual(controller._cut_off, {"running", "queued"})

    def test_a_request_is_pending_until_the_loop_has_processed_it(self):
        pending = []
        controller = SimpleNamespace(
            _executor=ThreadPoolExecutor(max_workers=1),
            _metrics_interval=5,
            _draining=True,
            servicer=SimpleNamespace(open_requests=set()),
            request_queue=__import__("queue").Queue(),
            _unsent=0,
            stop=lambda: None,
        )

        def process(data):
            pending.append(
                LocalController._collect_metrics(controller)["pending_requests"]
            )
            # Ends the loop, which would otherwise block on the empty queue.
            raise KeyboardInterrupt

        controller._process_request = process
        controller.request_queue.put(json.dumps({"future_id": "f1"}))

        LocalController.run(controller)

        self.assertEqual(pending, ["1"])
        self.assertEqual(
            LocalController._collect_metrics(controller)["pending_requests"], "0"
        )

    def test_a_call_the_drain_failed_reports_nothing_when_it_finishes(self):
        redis = _FakeRedis()
        stub = SimpleNamespace(WriteResult=MagicMock())
        controller = _bind_failure_marker(
            SimpleNamespace(
                redis=redis,
                agent=SimpleNamespace(greet=lambda: "late"),
                agent_name="Greeter",
                replica_id="agent-1",
                _my_address="target:50051",
                _metrics_key="controller:target:50051:metrics",
                _resolve_future_args=lambda args, future_args: args,
                _get_remote_stub=lambda endpoint: stub,
            )
        )
        controller._cut_off.add("future-5")

        with patch(
            "canyonos_core.controller.local_controller.read_gpu_percent",
            return_value=0.0,
        ):
            LocalController._execute_locally(
                controller, "Greeter", "greet", {}, "future-5", origin="origin:50051"
            )

        # Its caller already got ReplicaRemovedError; that answer stands.
        self.assertIsNone(redis.hget("future:future-5", "result"))
        stub.WriteResult.assert_not_called()

    def test_a_stateful_request_run_here_is_held_open_until_cleanup(self):
        for stateful, expected in (({"Alpha"}, {"r1"}), (set(), set())):
            with self.subTest(stateful=stateful):
                executor = MagicMock()
                controller = SimpleNamespace(
                    redis=_FakeRedis(),
                    agent=SimpleNamespace(run=lambda: None),
                    agent_name="Alpha",
                    _my_address="localhost:50051",
                    _metrics_key="controller:localhost:50051:metrics",
                    _stateful=stateful,
                    servicer=SimpleNamespace(open_requests=set()),
                    _check_policy=lambda service, context: True,
                    _executor=executor,
                    _executor_futures={},
                    _executor_futures_lock=threading.Lock(),
                    _forget_executor_future=lambda future: None,
                    _execute_locally=lambda *args: None,
                )

                LocalController._process_request(
                    controller,
                    {
                        "service": "Alpha",
                        "function": "run",
                        "future_id": "f1",
                        "request_id": "r1",
                        "route_to": "localhost:50051",
                    },
                )

                executor.submit.assert_called_once()
                self.assertEqual(controller.servicer.open_requests, expected)

    def test_metrics_loop_writes_hash_and_refreshes_status_once_ready(self):
        redis = _FakeRedis()
        self._run_one_metrics_tick(redis, ready=True)

        self.assertEqual(
            redis.hgetall("controller:localhost:50051:metrics")["queue_length"], "3"
        )
        self.assertEqual(redis.get("controller:localhost:50051:status"), "healthy")

    def test_metrics_loop_heartbeats_without_reporting_healthy_before_ready(self):
        redis = _FakeRedis()
        redis.set("controller:localhost:50051:status", "initializing")
        self._run_one_metrics_tick(redis, ready=False)

        self.assertEqual(
            redis.hgetall("controller:localhost:50051:metrics")["observed_at"], "100.0"
        )
        self.assertEqual(redis.get("controller:localhost:50051:status"), "initializing")

    def test_reload_replaces_cached_policy_rules(self):
        redis = _FakeRedis()
        redis.set("policy:rules", json.dumps([{"match": {}, "access": "all"}]))
        controller = SimpleNamespace(redis=redis, _policy_rules=None)

        LocalController._load_policy_rules(controller)
        redis.set("policy:rules", json.dumps([{"match": {}, "access": ["A"]}]))

        self.assertEqual(
            LocalController._load_policy_rules(controller)[0]["access"], "all"
        )
        self.assertEqual(
            LocalController._load_policy_rules(controller, reload=True)[0]["access"],
            ["A"],
        )

    def test_metrics_loop_does_not_overwrite_failed(self):
        redis = _FakeRedis()
        redis.set("controller:localhost:50051:status", "failed")
        self._run_one_metrics_tick(redis, ready=False)

        self.assertEqual(redis.get("controller:localhost:50051:status"), "failed")

    def test_execute_locally_writes_gpu_resource_to_future_hash(self):
        redis = _FakeRedis()
        agent = SimpleNamespace(greet=lambda name: f"hello {name}")
        controller = _bind_failure_marker(
            SimpleNamespace(
                redis=redis,
                agent=agent,
                agent_name="Greeter",
                replica_id="1f2e3d4c5b6a7988fedcba9876543210",
                _my_address="localhost:50051",
                _metrics_key="controller:localhost:50051:metrics",
                _resolve_future_args=lambda args, future_args: args,
            )
        )

        with patch(
            "canyonos_core.controller.local_controller.read_gpu_percent",
            return_value=17.5,
        ):
            LocalController._execute_locally(
                controller,
                "Greeter",
                "greet",
                {"name": "world"},
                "future-1",
                parent="future-0",
            )

        self.assertEqual(redis.hget("future:future-1", "gpu_resource"), 17.5)
        self.assertEqual(redis.hget("future:future-1", "result"), "hello world")
        self.assertEqual(
            redis.hget("future:future-1", "agent"),
            "1f2e3d4c5b6a7988fedcba9876543210",
        )
        self.assertNotIn("future:future-1:metrics", redis.hashes)
        self.assertEqual(
            redis.hget("controller:localhost:50051:metrics", "requests_served"), 1
        )

    def test_execute_locally_counts_failed_executions_as_served(self):
        redis = _FakeRedis()

        def boom(name):
            raise ValueError("nope")

        agent = SimpleNamespace(greet=boom)
        controller = _bind_failure_marker(
            SimpleNamespace(
                redis=redis,
                agent=agent,
                agent_name="Greeter",
                replica_id="aabbccddeeff00112233445566778899",
                _my_address="localhost:50051",
                _metrics_key="controller:localhost:50051:metrics",
                _resolve_future_args=lambda args, future_args: args,
            )
        )

        with patch(
            "canyonos_core.controller.local_controller.read_gpu_percent",
            return_value=0.0,
        ):
            LocalController._execute_locally(
                controller, "Greeter", "greet", {"name": "world"}, "future-2"
            )

        self.assertEqual(
            redis.hget("future:future-2", "error"),
            "Greeter.greet failed: ValueError: nope",
        )
        self.assertIsNone(redis.hget("future:future-2", "result"))
        self.assertEqual(redis.hget("future:future-2", "failed"), 1)
        logs = json.loads(redis.hget("future:future-2", "logs"))
        self.assertEqual(logs[0]["Body"], "nope")
        self.assertNotIn("future:future-2:metrics", redis.hashes)
        self.assertEqual(
            redis.hget("controller:localhost:50051:metrics", "requests_served"), 1
        )
        self.assertEqual(
            redis.hget("controller:localhost:50051:metrics", "full_failures"), 1
        )

    def test_execute_locally_marks_missing_agent_as_failed(self):
        redis = _FakeRedis()
        controller = _bind_failure_marker(
            SimpleNamespace(
                redis=redis,
                agent=None,
                agent_name="MissingAgent",
                replica_id="agent-1",
                _my_address="localhost:50051",
                _metrics_key="controller:localhost:50051:metrics",
            )
        )

        with patch(
            "canyonos_core.controller.local_controller.read_gpu_percent",
            return_value=0.0,
        ):
            LocalController._execute_locally(
                controller, "MissingAgent", "greet", {}, "future-3"
            )

        self.assertEqual(redis.hget("future:future-3", "error"), "No agent loaded")
        self.assertEqual(redis.hget("future:future-3", "failed"), 1)
        self.assertNotIn("future:future-3:metrics", redis.hashes)
        logs = json.loads(redis.hget("future:future-3", "logs"))
        self.assertEqual(logs[0]["Body"], "No agent loaded")
        self.assertEqual(logs[0]["Attributes"]["exception.type"], "NoAgentLoaded")

    def test_remote_execution_failure_sends_error_callback(self):
        redis = _FakeRedis()
        stub = SimpleNamespace(WriteResult=MagicMock())

        def boom():
            raise ValueError("remote nope")

        controller = _bind_failure_marker(
            SimpleNamespace(
                redis=redis,
                agent=SimpleNamespace(greet=boom),
                agent_name="Greeter",
                replica_id="agent-1",
                _my_address="target:50051",
                _metrics_key="controller:target:50051:metrics",
                _resolve_future_args=lambda args, future_args: args,
                _get_remote_stub=lambda address: stub,
            )
        )

        with patch(
            "canyonos_core.controller.local_controller.read_gpu_percent",
            return_value=0.0,
        ):
            LocalController._execute_locally(
                controller,
                "Greeter",
                "greet",
                {},
                "future-4",
                origin="origin:50051",
            )

        message = "Greeter.greet failed: ValueError: remote nope"
        self.assertEqual(redis.hget("future:future-4", "error"), message)
        payload = json.loads(stub.WriteResult.call_args.args[0].response)
        self.assertEqual(payload["future_id"], "future-4")
        self.assertNotIn("result", payload)
        self.assertEqual(payload["failed"], 1)
        self.assertEqual(payload["error"], message)
        # The callback fires only after the finally block writes final metrics,
        # so the snapshot sent to origin carries the full execution record.
        self.assertEqual(payload["agent"], "agent-1")
        self.assertIn("finished_at", payload)
        self.assertIn("cpu_resource", payload)
        self.assertEqual(payload["gpu_resource"], 0.0)
        # logs is just another hash field, so it rides along in the same
        # snapshot automatically -- the origin gets the full detail for free.
        logs = json.loads(payload["logs"])
        self.assertEqual(logs[0]["Body"], "remote nope")
        self.assertEqual(logs[0]["Attributes"]["agent.id"], "agent-1")
        self.assertEqual(logs[0]["Attributes"]["endpoint"], "target:50051")

    def test_callback_fires_once_and_only_after_final_metrics_written(self):
        redis = _FakeRedis()
        seen_at_callback_time = {}

        def spy_send_result_callback(
            origin, future_id, result=None, failed=0, error_message=""
        ):
            seen_at_callback_time["snapshot"] = dict(
                redis.hashes.get(f"future:{future_id}", {})
            )
            seen_at_callback_time["calls"] = seen_at_callback_time.get("calls", 0) + 1

        controller = SimpleNamespace(
            redis=redis,
            agent=SimpleNamespace(greet=lambda name: f"hello {name}"),
            agent_name="Greeter",
            replica_id="agent-1",
            _my_address="target:50051",
            _metrics_key="controller:target:50051:metrics",
            _cut_off=set(),
            _resolve_future_args=lambda args, future_args: args,
            _mark_future_failed=lambda *a, **k: None,
            _send_result_callback=spy_send_result_callback,
        )

        with patch(
            "canyonos_core.controller.local_controller.read_gpu_percent",
            return_value=0.0,
        ):
            LocalController._execute_locally(
                controller,
                "Greeter",
                "greet",
                {"name": "world"},
                "future-5",
                origin="origin:50051",
            )

        self.assertEqual(seen_at_callback_time["calls"], 1)
        self.assertIn("finished_at", seen_at_callback_time["snapshot"])
        self.assertIn("cpu_resource", seen_at_callback_time["snapshot"])
        self.assertIn("gpu_resource", seen_at_callback_time["snapshot"])
        self.assertIn("agent", seen_at_callback_time["snapshot"])


if __name__ == "__main__":
    unittest.main()
