# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

import json
import unittest
from unittest.mock import patch

from canyonos_core.endpoint.app import create_app

from fakes import _FakeRedis


def _wait(redis, request_id, future_id, question):
    redis.lpush(
        f"request:{request_id}:waiting",
        json.dumps(
            {
                "future_id": future_id,
                "question": {"question": question, "input_schema": {"input": "str"}},
            }
        ),
    )


class EndpointHumanReplyTests(unittest.TestCase):
    def setUp(self):
        self.redis = _FakeRedis()
        self.client = create_app("Workflow", "main", self.redis).test_client()
        patcher = patch("canyonos_core.endpoint.app.Future")
        self.future = patcher.start()
        self.addCleanup(patcher.stop)
        self.write = self.future._get_stub.return_value.WriteResult

    def _reply(self, **body):
        return self.client.post("/answer/r1", json=body)

    def _sent(self):
        return json.loads(self.write.call_args.args[0].response)

    def test_reply_hands_the_body_to_the_endpoint_controller(self):
        _wait(self.redis, "r1", "q1", "Sell TSLA?")

        response = self._reply(input="yes")

        self.assertEqual(response.status_code, 202)
        self.assertEqual(response.get_json(), {"request_id": "r1"})
        sent = self._sent()
        self.assertEqual(sent["future_id"], "q1")
        self.assertEqual(json.loads(sent["result"]), {"input": "yes"})
        self.assertIn("finished_at", sent)
        self.assertEqual(self.redis.lrange("request:r1:waiting"), [])
        self.future.assert_not_called()

    def test_a_request_id_in_the_body_starts_a_request_instead_of_answering(self):
        _wait(self.redis, "r1", "q1", "Sell TSLA?")

        # Patched so the new request's id doesn't stay set in this test's thread.
        with patch("canyonos_core.endpoint.app.canyonos_context.set_request_id"):
            response = self.client.post(
                "/main", json={"query": "yes", "_request_id": "r1"}
            )

        self.assertEqual(response.status_code, 202)
        self.assertNotEqual(response.get_json()["request_id"], "r1")
        self.assertEqual(
            self.future.call_args.kwargs["args"], {"query": "yes", "_request_id": "r1"}
        )
        self.write.assert_not_called()
        self.assertEqual(len(self.redis.lrange("request:r1:waiting")), 1)

    def test_reply_that_is_not_a_json_object_is_400_and_answers_nothing(self):
        _wait(self.redis, "r1", "q1", "Sell TSLA?")

        response = self.client.post("/answer/r1", json=["yes"])

        self.assertEqual(response.status_code, 400)
        self.write.assert_not_called()
        self.assertEqual(len(self.redis.lrange("request:r1:waiting")), 1)

    def test_reply_with_nothing_waiting_is_409(self):
        response = self._reply(input="yes")

        self.assertEqual(response.status_code, 409)
        self.assertEqual(
            response.get_json(), {"error": "Request r1 is not waiting for input"}
        )
        self.future.assert_not_called()
        self.write.assert_not_called()

    def test_reply_answers_oldest_question_first(self):
        self.redis.set("request:r1:future", "f1")
        _wait(self.redis, "r1", "q1", "first?")
        _wait(self.redis, "r1", "q2", "second?")

        self._reply(input="yes")

        self.assertEqual(self._sent()["future_id"], "q1")
        status = self.client.get("/status/r1").get_json()
        self.assertEqual(status["question"]["question"], "second?")

    def test_status_reports_input_required_with_the_oldest_question(self):
        self.redis.set("request:r1:future", "f1")
        _wait(self.redis, "r1", "q1", "Sell TSLA?")
        _wait(self.redis, "r1", "q2", "Buy NVDA?")

        response = self.client.get("/status/r1")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.get_json(),
            {
                "request_id": "r1",
                "status": "input_required",
                "question": {
                    "question": "Sell TSLA?",
                    "input_schema": {"input": "str"},
                },
            },
        )

    def test_status_reports_done_with_the_result(self):
        self.redis.set("request:r1:future", "f1")
        self.redis.hset("future:f1", "result", json.dumps({"value": 1}))

        response = self.client.get("/status/r1")

        self.assertEqual(
            response.get_json(),
            {"request_id": "r1", "status": "done", "result": {"value": 1}},
        )

    def test_status_reports_error_with_its_message(self):
        self.redis.set("request:r1:future", "f1")
        self.redis.hset_multiple(
            "future:f1", {"failed": 1, "error": "ValueError", "error_message": "boom"}
        )

        response = self.client.get("/status/r1")

        self.assertEqual(
            response.get_json(),
            {"request_id": "r1", "status": "error", "error": "boom"},
        )


if __name__ == "__main__":
    unittest.main()
