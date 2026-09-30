"""Unit tests for Hooks._extract_usage's per-provider/op/model dispatch."""

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from canyonos_core.llm_gateway.hooks import FUTURE_ID_HEADER, Ctx, Hooks
from canyonos_core.llm_gateway.providers.base import GatewayResponse
from fakes import _FakeRedis


def _ctx(provider, subpath):
    return Ctx(
        provider=provider, method="POST", subpath=subpath, body=b"", headers={}, t0=0.0
    )


def _json_response(obj, status=200):
    return GatewayResponse(status=status, headers=[], content=json.dumps(obj).encode())


class ExtractUsageTests(unittest.TestCase):
    def setUp(self):
        self.hooks = Hooks()

    def test_bedrock_converse_uses_camel_case_schema(self):
        resp = _json_response(
            {"usage": {"inputTokens": 3, "outputTokens": 5, "totalTokens": 8}}
        )
        usage = self.hooks._extract_usage(
            _ctx("bedrock", "model/anthropic.claude-3/converse"), resp
        )
        self.assertEqual(
            (usage.input_tokens, usage.output_tokens, usage.total_tokens), (3, 5, 8)
        )

    def test_bedrock_converse_stream_reads_stream_usage_not_content(self):
        resp = GatewayResponse(status=200, headers=[])
        resp.stream = iter([b""])
        resp.stream_usage = {"inputTokens": 1, "outputTokens": 2, "totalTokens": 3}
        usage = self.hooks._extract_usage(
            _ctx("bedrock", "model/anthropic.claude-3/converse-stream"), resp
        )
        self.assertEqual((usage.input_tokens, usage.output_tokens), (1, 2))

    def test_bedrock_invoke_anthropic_model_uses_snake_case_schema(self):
        resp = _json_response({"usage": {"input_tokens": 10, "output_tokens": 20}})
        usage = self.hooks._extract_usage(
            _ctx("bedrock", "model/anthropic.claude-3-5-sonnet-20240620-v1:0/invoke"),
            resp,
        )
        self.assertEqual(
            (usage.input_tokens, usage.output_tokens, usage.total_tokens), (10, 20, 30)
        )

    def test_bedrock_invoke_non_anthropic_model_yields_no_usage(self):
        # Llama's native invoke body has no "usage" key at all -- unsupported for now.
        resp = _json_response(
            {"generation": "hi", "prompt_token_count": 5, "generation_token_count": 7}
        )
        usage = self.hooks._extract_usage(
            _ctx("bedrock", "model/meta.llama3-8b-instruct-v1:0/invoke"), resp
        )
        self.assertIsNone(usage)

    def test_bedrock_invoke_with_response_stream_yields_no_usage(self):
        resp = GatewayResponse(status=200, headers=[])
        resp.stream = iter([b""])
        resp.stream_usage = None
        usage = self.hooks._extract_usage(
            _ctx(
                "bedrock",
                "model/meta.llama3-8b-instruct-v1:0/invoke-with-response-stream",
            ),
            resp,
        )
        self.assertIsNone(usage)

    def test_direct_anthropic_api_uses_snake_case_schema(self):
        resp = _json_response({"usage": {"input_tokens": 4, "output_tokens": 6}})
        usage = self.hooks._extract_usage(_ctx("anthropic", "v1/messages"), resp)
        self.assertEqual(
            (usage.input_tokens, usage.output_tokens, usage.total_tokens), (4, 6, 10)
        )

    def test_direct_openai_api_uses_openai_schema(self):
        resp = _json_response(
            {"usage": {"prompt_tokens": 7, "completion_tokens": 9, "total_tokens": 16}}
        )
        usage = self.hooks._extract_usage(_ctx("openai", "v1/chat/completions"), resp)
        self.assertEqual(
            (usage.input_tokens, usage.output_tokens, usage.total_tokens), (7, 9, 16)
        )

    def test_direct_openai_responses_api_uses_input_output_schema(self):
        resp = _json_response(
            {"usage": {"input_tokens": 12, "output_tokens": 5, "total_tokens": 17}}
        )
        usage = self.hooks._extract_usage(_ctx("openai", "v1/responses"), resp)
        self.assertEqual(
            (usage.input_tokens, usage.output_tokens, usage.total_tokens), (12, 5, 17)
        )

    def test_non_200_status_yields_no_usage(self):
        resp = _json_response(
            {"usage": {"input_tokens": 1, "output_tokens": 1}}, status=400
        )
        usage = self.hooks._extract_usage(_ctx("anthropic", "v1/messages"), resp)
        self.assertIsNone(usage)


class RecordUsageTests(unittest.TestCase):
    def test_every_call_on_a_future_adds_to_its_totals(self):
        hooks = Hooks()
        hooks._redis = _FakeRedis()
        ctx = _ctx("openai", "v1/responses")
        ctx.headers = {FUTURE_ID_HEADER: "f1"}

        hooks.on_response(
            ctx, _json_response({"usage": {"input_tokens": 3, "output_tokens": 2}})
        )
        hooks.on_response(ctx, _json_response({}, status=500))
        hooks.on_response(
            ctx, _json_response({"usage": {"input_tokens": 4, "output_tokens": 1}})
        )

        future = hooks._redis.hgetall("future:f1")
        self.assertEqual(future["input_token_count"], 7)
        self.assertEqual(future["output_token_count"], 3)
        self.assertEqual(future["token_count"], 10)
        self.assertEqual(future["errors"], 1)

    def test_a_successful_call_without_usage_logs_a_warning(self):
        with self.assertLogs("llm_gateway", level="WARNING") as logs:
            Hooks().on_response(_ctx("openai", "v1/responses"), _json_response({}))

        self.assertIn("No token usage found", logs.output[0])

    def test_a_call_without_a_future_id_logs_a_warning(self):
        hooks = Hooks()
        hooks._redis = _FakeRedis()
        response = _json_response({"usage": {"input_tokens": 3, "output_tokens": 2}})

        with self.assertLogs("llm_gateway", level="WARNING") as logs:
            hooks.on_response(_ctx("openai", "v1/responses"), response)

        self.assertIn(FUTURE_ID_HEADER, logs.output[0])

    def test_a_call_without_redis_logs_a_warning(self):
        ctx = _ctx("openai", "v1/responses")
        ctx.headers = {FUTURE_ID_HEADER: "f1"}
        response = _json_response({"usage": {"input_tokens": 3, "output_tokens": 2}})

        with self.assertLogs("llm_gateway", level="WARNING") as logs:
            Hooks().on_response(ctx, response)

        self.assertIn("Redis is not connected", logs.output[0])


if __name__ == "__main__":
    unittest.main()
