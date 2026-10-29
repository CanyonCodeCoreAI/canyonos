# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

import json
import logging
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

import canyonos_core.controller.canyonos_context as canyonos_context
import canyonos_core.controller.future as future_module
from canyonos_core import endpoint
from canyonos_core.controller.future import Future
from canyonos_core.controller.local_controller import (
    FUTURE_RESULT_TIMEOUT_SECONDS,
    LocalController,
    _resolved,
)
from canyonos_core.controller.local_controller_frontend import (
    FUTURE_CLEANUP_GRACE_SECONDS,
    LocalControllerServicer,
)
from canyonos_core.controller.utils.human_input import (
    QUESTION_TIMEOUT_SECONDS,
    ask_human,
)
from canyonos_core.controller.utils.log_handler import LogHandler

import local_controller_pb2

from fakes import _FakeRedis


def _endpoint_controller(redis):
    """A controller that routes calls to itself, as the endpoint's does, with the real
    path for failing questions bound to it."""
    controller = SimpleNamespace(
        redis=redis,
        replica_id=None,
        agent_name=None,
        _my_address="endpoint-0:50051",
        _executor=Mock(),
        _resolve_address=lambda agent_name, request_id: "endpoint-0:50051",
        _get_remote_stub=Mock(),
        _forwarded={},
    )
    for name in (
        "_send_result_callback",
        "_mark_future_failed",
        "_fail_waiting_questions",
        "_fan_out_to_consumers",
        "_request_context",
    ):
        setattr(controller, name, getattr(LocalController, name).__get__(controller))
    return controller


def _hold_question(controller, future_id="q1", origin="risk-0:50051"):
    LocalController._process_request(
        controller,
        {
            "service": "endpoint",
            "function": "ask_human",
            "future_id": future_id,
            "request_id": "r1",
            "parent": "f0",
            "created_at": 1.0,
            "origin": origin,
            "args": {"question": "Sell TSLA?"},
        },
    )


def _sent(controller):
    """Each controller the endpoint's controller sent a result to, with what it sent."""
    return [
        (target.args[0], json.loads(write.args[0].response))
        for target, write in zip(
            controller._get_remote_stub.call_args_list,
            controller._get_remote_stub.return_value.WriteResult.call_args_list,
        )
    ]


def _write_result(servicer, payload):
    LocalControllerServicer.WriteResult(
        servicer,
        local_controller_pb2.JsonResponse(response=json.dumps(payload)),
        SimpleNamespace(peer=lambda: "peer:50051"),
    )


class FutureWaitTests(unittest.TestCase):
    def test_resolved_waits_longer_than_a_question(self):
        calls = []
        future = Future.__new__(Future)
        future.value = lambda **kwargs: calls.append(kwargs) or "r"

        self.assertEqual(_resolved({"a": [future]}), {"a": ["r"]})
        self.assertEqual(calls, [{"timeout": FUTURE_RESULT_TIMEOUT_SECONDS}])
        self.assertGreater(FUTURE_RESULT_TIMEOUT_SECONDS, QUESTION_TIMEOUT_SECONDS)

    def _resolve(self, wait):
        with patch("canyonos_core.controller.local_controller.wait_for_result", wait):
            return LocalController._resolve_future_args(
                SimpleNamespace(redis=_FakeRedis()), {"x": "f1"}, ["x"]
            )

    def test_resolve_future_args_waits_past_the_question_limit(self):
        waits = []

        def answered(_redis, future_id, timeout):
            waits.append((future_id, timeout))
            return "done"

        self.assertEqual(self._resolve(answered), {"x": "done"})
        # A question can take QUESTION_TIMEOUT_SECONDS to answer; the wait outlasts it.
        self.assertEqual(waits, [("f1", FUTURE_RESULT_TIMEOUT_SECONDS)])

    def test_resolve_future_args_gives_up_after_its_limit(self):
        def never_answered(_redis, future_id, timeout):
            raise TimeoutError(
                f"Future {future_id} not available within {timeout} seconds"
            )

        with self.assertRaisesRegex(TimeoutError, "argument 'x'"):
            self._resolve(never_answered)


class AskHumanTests(unittest.TestCase):
    def test_endpoint_agent_name_matches_the_endpoint_package(self):
        self.assertEqual(
            future_module.ENDPOINT_AGENT_NAME, endpoint.ENDPOINT_AGENT_NAME
        )

    def test_ask_human_sends_the_question_and_returns_the_reply_body(self):
        redis, asked = _FakeRedis(), []

        def answer(future):
            asked.append(future)
            redis.hset(f"future:{future.id}", "result", json.dumps({"input": True}))

        with (
            patch.object(canyonos_context, "get_request_id", return_value="r1"),
            patch.object(Future, "redis", redis),
            patch.object(Future, "_submit_request", answer),
        ):
            reply = ask_human("Sell TSLA?", {"input": "bool"})

        self.assertEqual(reply, {"input": True})
        key = f"future:{asked[0].id}"
        self.assertEqual(redis.hget(key, "service"), "endpoint")
        self.assertEqual(redis.hget(key, "method"), "ask_human")
        self.assertEqual(
            json.loads(redis.hget(key, "args")),
            {"question": {"question": "Sell TSLA?", "input_schema": {"input": "bool"}}},
        )

    def test_ask_human_raises_once_an_hour_passes_without_a_reply(self):
        with (
            patch.object(canyonos_context, "get_request_id", return_value="r1"),
            patch.object(Future, "redis", _FakeRedis()),
            patch.object(Future, "_submit_request", lambda future: None),
            patch(
                "canyonos_core.controller.future.wait_for_result",
                side_effect=TimeoutError("no reply"),
            ) as wait,
        ):
            with self.assertRaisesRegex(TimeoutError, "did not answer within an hour"):
                ask_human("Sell TSLA?", {"input": "str"})

        # The question is waited on for its whole hour, then given up.
        self.assertEqual(wait.call_args.args[2], QUESTION_TIMEOUT_SECONDS)

    def test_ask_human_outside_a_request_raises_at_once(self):
        redis = _FakeRedis()
        with (
            patch.object(Future, "redis", redis),
            patch.object(Future, "_submit_request") as submit,
            patch.object(Future, "value", return_value="{}"),
        ):
            with self.assertRaisesRegex(RuntimeError, "needs a request"):
                ask_human("Sell TSLA?", {"input": "str"})

        submit.assert_not_called()
        self.assertEqual(redis.hashes, {})

    def test_endpoint_controller_holds_a_question_instead_of_running_it(self):
        redis = _FakeRedis()
        redis.set("request:r1:future", "root1")
        controller = _endpoint_controller(redis)

        _hold_question(controller)

        self.assertEqual(
            redis.lrange("request:r1:waiting"),
            [json.dumps({"future_id": "q1", "question": "Sell TSLA?"})],
        )
        self.assertEqual(redis.smembers("future:q1:consumers"), {"risk-0:50051"})
        self.assertEqual(redis.smembers("request:r1:futures"), {"q1"})
        controller._executor.submit.assert_not_called()

    def test_an_answer_reaches_the_asker_through_the_endpoint_controller(self):
        redis = _FakeRedis()
        controller = _endpoint_controller(redis)
        _hold_question(controller)
        servicer = SimpleNamespace(
            redis=redis,
            on_result=controller._fan_out_to_consumers,
            on_request_done=Mock(),
        )

        _write_result(
            servicer,
            {"future_id": "q1", "result": '{"input": "yes"}', "finished_at": 5},
        )

        [(asker, sent)] = _sent(controller)
        self.assertEqual(asker, "risk-0:50051")
        self.assertEqual(
            (sent["future_id"], sent["result"], sent["failed"], sent["finished_at"]),
            ("q1", '{"input": "yes"}', 0, 5),
        )

    def test_holding_a_question_logs_nothing_on_the_endpoint(self):
        # The question's log lives only on the asking agent's machine.
        redis = _FakeRedis()
        controller_logger = logging.getLogger(
            "canyonos_core.controller.local_controller"
        )
        handler = LogHandler(redis, address="endpoint-0:50051")
        controller_logger.addHandler(handler)
        self.addCleanup(controller_logger.removeHandler, handler)
        self.addCleanup(controller_logger.setLevel, controller_logger.level)
        controller_logger.setLevel(logging.INFO)

        _hold_question(_endpoint_controller(redis))

        self.assertNotIn("logs", redis.hgetall("future:q1"))

    def test_question_after_its_request_finished_fails_at_once(self):
        redis = _FakeRedis()
        redis.set("request:r1:future", "root1")
        redis.hset("future:root1", "result", json.dumps({"value": 1}))
        controller = _endpoint_controller(redis)

        _hold_question(controller)

        [(asker, sent)] = _sent(controller)
        self.assertEqual(
            (asker, sent["future_id"], sent["failed"], sent["error"]),
            (
                "risk-0:50051",
                "q1",
                1,
                "Request finished before the question was answered",
            ),
        )
        self.assertEqual(redis.lrange("request:r1:waiting"), [])


class FinishedRequestTests(unittest.TestCase):
    def test_finished_request_fails_its_waiting_questions(self):
        redis = _FakeRedis()
        controller = _endpoint_controller(redis)
        _hold_question(controller, "q1", "risk-0:50051")
        _hold_question(controller, "q2", "price-0:50051")

        controller._fail_waiting_questions("r1")

        sent = _sent(controller)
        self.assertEqual(
            [(e, s["future_id"], s["failed"], s["error"]) for e, s in sent],
            [
                (
                    "risk-0:50051",
                    "q1",
                    1,
                    "Request finished before the question was answered",
                ),
                (
                    "price-0:50051",
                    "q2",
                    1,
                    "Request finished before the question was answered",
                ),
            ],
        )
        # Telemetry exports only finished spans, so a failed question needs finished_at too.
        self.assertTrue(all("finished_at" in s for _, s in sent))
        # Redis rejects None, so one null field would drop the whole notice at the asker.
        self.assertTrue(all(None not in s.values() for _, s in sent))
        self.assertEqual(redis.lrange("request:r1:waiting"), [])

    def test_a_question_leaves_nothing_on_the_endpoint_that_cleanup_misses(self):
        redis = _FakeRedis()
        controller = _endpoint_controller(redis)
        write = controller._get_remote_stub.return_value.WriteResult
        # Every send fails, as to an asker that is gone.
        write.side_effect = RuntimeError("asking replica is gone")
        _hold_question(controller)
        controller._fail_waiting_questions("r1")
        redis.set("telemetry:delivered:r1", "1")
        servicer = SimpleNamespace(redis=redis, my_address="endpoint-0:50051")

        LocalControllerServicer._cleanup_request(servicer, "r1")

        # The full hash, then one short failure note.
        self.assertEqual(write.call_count, 2)
        self.assertEqual(
            redis.hget("future:q1", "error"),
            "Request finished before the question was answered",
        )
        self.assertEqual(
            {key: redis.ttls.get(key) for key in redis.scan_keys("*")},
            dict.fromkeys(redis.scan_keys("*"), FUTURE_CLEANUP_GRACE_SECONDS),
        )

    def test_only_a_root_result_reports_its_request_done_from_its_own_thread(self):
        servicer = SimpleNamespace(
            redis=_FakeRedis(), on_result=Mock(), on_request_done=Mock()
        )
        with patch(
            "canyonos_core.controller.local_controller_frontend.Thread"
        ) as thread:
            for parent in ("", "f0"):
                _write_result(
                    servicer,
                    {
                        "future_id": "f1",
                        "request_id": "r1",
                        "parent": parent,
                        "result": "{}",
                    },
                )

        thread.assert_called_once_with(
            target=servicer.on_request_done, args=("r1",), daemon=True
        )
        thread.return_value.start.assert_called_once_with()

    def _started_controller(self, redis):
        """A LocalController with its gRPC server and Redis faked; returns it and its
        servicer."""
        servicer = SimpleNamespace(request_queue=None)
        with (
            patch(
                "canyonos_core.controller.local_controller.start_server",
                return_value=(Mock(), servicer),
            ),
            patch(
                "canyonos_core.controller.local_controller.RedisClient",
                return_value=redis,
            ),
            patch("canyonos_core.controller.local_controller.threading.Thread"),
            patch.object(LocalController, "_start_llm_gateway"),
            patch.object(LocalController, "_load_agent", return_value=None),
        ):
            return LocalController(), servicer

    def test_a_restarted_endpoint_still_fails_questions_held_before(self):
        redis = _FakeRedis()
        _hold_question(_endpoint_controller(redis))
        controller, servicer = self._started_controller(redis)
        controller._get_remote_stub = Mock()

        servicer.on_request_done("r1")

        [(asker, sent)] = _sent(controller)
        self.assertEqual(
            (asker, sent["future_id"], sent["failed"]), ("risk-0:50051", "q1", 1)
        )
        self.assertEqual(redis.lrange("request:r1:waiting"), [])


if __name__ == "__main__":
    unittest.main()
