"""Unit tests for the gateway setting each LLM call's system prompt from prompts:config."""

import json
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from flask import Flask

from canyonos_core.llm_gateway import core, prompts
from canyonos_core.llm_gateway.hooks import (
    FUNCTION_HEADER,
    FUTURE_ID_HEADER,
    Ctx,
    Hooks,
)
from canyonos_core.llm_gateway.providers.anthropic import AnthropicProvider
from canyonos_core.llm_gateway.providers.bedrock import BedrockProvider
from canyonos_core.llm_gateway.providers.openai import OpenAIProvider

CONFIG = {
    "prompts": {
        "IntentAgent.parse": {
            "version": "IntentAgent-parse-aaaaaaaa-v2",
            "content": "second",
        }
    }
}
BODY = json.dumps(
    {"messages": [{"role": "user", "content": [{"text": "hi"}]}]}
).encode()


# set_system needs no config or client, so skip the constructor that builds a boto3 client.
BEDROCK = BedrockProvider.__new__(BedrockProvider)


def _bedrock_forwarding():
    provider = BedrockProvider.__new__(BedrockProvider)
    provider.forward = mock.Mock(
        return_value=mock.Mock(stream=None, status=200, headers=[], content=b"{}")
    )
    return provider


def _redis(config):
    return mock.Mock(get=mock.Mock(return_value=json.dumps(config)))


class PromptsTests(unittest.TestCase):
    def setUp(self):
        prompts.refresh_prompts(_redis(CONFIG))

    def test_live_version_is_set_as_the_system_prompt(self):
        body, version = prompts.apply(
            BEDROCK, "IntentAgent.parse", "model/m/converse", BODY
        )
        self.assertEqual(json.loads(body)["system"], [{"text": "second"}])
        self.assertEqual(version, "IntentAgent-parse-aaaaaaaa-v2")

    def test_unknown_prompt_or_call_with_no_system_slot_is_left_alone(self):
        self.assertEqual(
            prompts.apply(BEDROCK, "Other.fn", "model/m/converse", BODY), (BODY, None)
        )
        no_slot = json.dumps({"inputs": "hi"}).encode()
        self.assertEqual(
            prompts.apply(BEDROCK, "IntentAgent.parse", "model/m/invoke", no_slot),
            (no_slot, None),
        )

    def test_a_body_that_is_not_a_json_object_is_left_alone(self):
        for body in (b"not json", b"[1, 2]", "\xff".encode("latin-1")):
            self.assertEqual(
                prompts.apply(BEDROCK, "IntentAgent.parse", "model/m/invoke", body),
                (body, None),
            )

    def test_failed_refresh_keeps_the_last_prompts(self):
        prompts.refresh_prompts(mock.Mock(get=mock.Mock(side_effect=ConnectionError)))
        body, _ = prompts.apply(
            BEDROCK, "IntentAgent.parse", "model/m/converse-stream", BODY
        )
        self.assertEqual(json.loads(body)["system"], [{"text": "second"}])

    def test_proxy_forwards_the_calling_functions_prompt(self):
        provider = _bedrock_forwarding()
        hooks = mock.Mock()
        with (
            mock.patch.object(core, "AGENT_NAME", "IntentAgent"),
            mock.patch.object(core, "route", return_value=None),
        ):
            app = Flask(__name__)
            with app.test_request_context(
                method="POST", data=BODY, headers={FUNCTION_HEADER: "parse"}
            ):
                from flask import request

                core.proxy_request(hooks, provider, "model/m/converse", request)

        forwarded = provider.forward.call_args.args[2]
        self.assertEqual(json.loads(forwarded)["system"], [{"text": "second"}])
        ctx = hooks.on_response.call_args.args[0]
        self.assertEqual(ctx.prompt_name, "IntentAgent.parse")
        self.assertEqual(ctx.prompt_version, "IntentAgent-parse-aaaaaaaa-v2")

    def test_without_prompts_config_calls_pass_through_and_record_no_prompt(self):
        prompts.refresh_prompts(mock.Mock(get=mock.Mock(return_value=None)))
        provider = _bedrock_forwarding()
        hooks = Hooks()
        hooks._redis = mock.Mock()
        with (
            mock.patch.object(core, "AGENT_NAME", "IntentAgent"),
            mock.patch.object(core, "route", return_value=None),
        ):
            app = Flask(__name__)
            with app.test_request_context(
                method="POST",
                data=BODY,
                headers={FUNCTION_HEADER: "parse", FUTURE_ID_HEADER: "f1"},
            ):
                from flask import request

                core.proxy_request(hooks, provider, "model/m/converse", request)

        self.assertEqual(provider.forward.call_args.args[2], BODY)
        written = {call.args[1] for call in hooks._redis.hset.call_args_list}
        self.assertNotIn("prompt_name", written)
        self.assertNotIn("prompt_version", written)

    def test_prompt_and_version_are_recorded_on_the_calling_future(self):
        hooks = Hooks()
        hooks._redis = mock.Mock()
        ctx = Ctx(
            provider="bedrock",
            method="POST",
            subpath="model/m/converse",
            body=BODY,
            headers={FUTURE_ID_HEADER: "f1"},
            t0=0.0,
            prompt_name="IntentAgent.parse",
            prompt_version="IntentAgent-parse-aaaaaaaa-v2",
        )
        resp = mock.Mock(stream=None, status=200, content=b"{}")

        hooks.on_response(ctx, resp)

        written = {call.args[1]: call.args for call in hooks._redis.hset.call_args_list}
        self.assertEqual(
            written["prompt_name"], ("future:f1", "prompt_name", "IntentAgent.parse")
        )
        self.assertEqual(
            written["prompt_version"],
            ("future:f1", "prompt_version", "IntentAgent-parse-aaaaaaaa-v2"),
        )


class SetSystemTests(unittest.TestCase):
    """Where each provider puts the system prompt in the request body."""

    def placed(self, provider, subpath, params):
        self.assertTrue(provider.set_system(params, subpath, "SYS"))
        return params

    def test_bedrock_converse_and_nova(self):
        for subpath in ("model/m/converse", "model/us.amazon.nova-pro-v1:0/invoke"):
            self.assertEqual(
                self.placed(BEDROCK, subpath, {})["system"], [{"text": "SYS"}]
            )

    def test_bedrock_invoke_by_model_family(self):
        cases = [
            ("anthropic.claude-3-haiku", {"messages": []}, "system", "SYS"),
            ("cohere.command-r-v1:0", {"message": "hi"}, "preamble", "SYS"),
            ("meta.llama3-8b-instruct-v1:0", {"prompt": "hi"}, "prompt", "SYS\n\nhi"),
            (
                "amazon.titan-text-express-v1",
                {"inputText": "hi"},
                "inputText",
                "SYS\n\nhi",
            ),
        ]
        for model, params, field, expected in cases:
            body = self.placed(BEDROCK, f"model/{model}/invoke", params)
            self.assertEqual(body[field], expected, model)

    def test_bedrock_invoke_chat_messages_get_a_leading_system_message(self):
        body = self.placed(
            BEDROCK,
            "model/ai21.jamba-1-5-mini-v1:0/invoke-with-response-stream",
            {
                "messages": [
                    {"role": "system", "content": "old"},
                    {"role": "user", "content": "hi"},
                ]
            },
        )
        self.assertEqual(
            body["messages"],
            [{"role": "system", "content": "SYS"}, {"role": "user", "content": "hi"}],
        )

    def test_anthropic_messages(self):
        provider = AnthropicProvider(None)
        self.assertEqual(self.placed(provider, "v1/messages", {})["system"], "SYS")
        self.assertFalse(provider.set_system({}, "v1/messages/count_tokens", "SYS"))

    def test_openai_chat_completions_and_responses(self):
        provider = OpenAIProvider(None)
        chat = self.placed(
            provider,
            "v1/chat/completions",
            {
                "messages": [
                    {"role": "developer", "content": "old"},
                    {"role": "user", "content": "hi"},
                ]
            },
        )
        self.assertEqual(
            chat["messages"],
            [{"role": "system", "content": "SYS"}, {"role": "user", "content": "hi"}],
        )
        self.assertEqual(
            self.placed(provider, "v1/responses", {})["instructions"], "SYS"
        )
        self.assertFalse(provider.set_system({}, "v1/embeddings", "SYS"))


if __name__ == "__main__":
    unittest.main()
