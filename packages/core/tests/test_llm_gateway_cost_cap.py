"""Unit tests for the LLM proxy's per-agent model allowlist and cost cap."""

import json
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from flask import Flask

from canyonos_core.llm_gateway import core, llms, routing

HAIKU = {
    "model_id": "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    "max_tokens": 1024,
    "agents": {"IntentAgent": 0.01},
}


def _body(max_tokens):
    return json.dumps({"inferenceConfig": {"maxTokens": max_tokens}}).encode()


def _use(llm):
    return mock.patch.object(llms, "llms_by_model_id", llms.index_llms({"haiku": llm}))


def _loaded_names():
    return [llm["name"] for llm in llms.llms_by_model_id.values()]


def _as(agent_name):
    return mock.patch.object(routing, "AGENT_NAME", agent_name)


class CostCapTests(unittest.TestCase):
    def test_call_under_the_cap_is_allowed(self):
        with _use(HAIKU), _as("IntentAgent"):
            self.assertIsNone(routing.route(HAIKU["model_id"], _body(500)))

    def test_call_over_the_cap_is_blocked(self):
        with _use(HAIKU), _as("IntentAgent"):
            reason = routing.route(HAIKU["model_id"], _body(4000))
        self.assertTrue(reason.startswith("canyonos denied: IntentAgent call to haiku"))
        self.assertIn("over its $0.01 per-request cap", reason)

    def test_agent_not_listed_is_blocked(self):
        with _use(HAIKU), _as("RiskAgent"):
            reason = routing.route(HAIKU["model_id"], _body(1))
        self.assertEqual(
            reason, "canyonos denied: RiskAgent is not allowed to use haiku"
        )

    def test_model_without_agents_is_open_to_everyone(self):
        open_llm = {k: v for k, v in HAIKU.items() if k != "agents"}
        with _use(open_llm), _as("RiskAgent"):
            self.assertIsNone(routing.route(HAIKU["model_id"], _body(100000)))

    def test_agent_without_a_cap_is_allowed(self):
        with _use({**HAIKU, "agents": {"IntentAgent": None}}), _as("IntentAgent"):
            self.assertIsNone(routing.route(HAIKU["model_id"], _body(100000)))

    def test_model_not_in_llms_yaml_is_allowed(self):
        with _use(HAIKU), _as("IntentAgent"):
            self.assertIsNone(routing.route("other", _body(100000)))

    def test_calls_are_refused_until_the_config_loads(self):
        with mock.patch.object(llms, "llms_by_model_id", None):
            self.assertIsNotNone(routing.route(HAIKU["model_id"], _body(1)))

    def test_bedrock_foundation_model_arn_is_matched(self):
        llm = {**HAIKU, "model_id": "meta.llama3-8b-instruct-v1:0"}
        arn = "arn:aws:bedrock:us-east-1::foundation-model/meta.llama3-8b-instruct-v1:0"
        with _use(llm), _as("RiskAgent"):
            self.assertIn("not allowed", routing.route(arn, _body(1)))

    def test_bedrock_inference_profile_arn_is_matched(self):
        arn = (
            "arn:aws:bedrock:us-east-1:123456789012:inference-profile/"
            "us.anthropic.claude-haiku-4-5-20251001-v1:0"
        )
        with _use(HAIKU), _as("IntentAgent"):
            self.assertIn("per-request cap", routing.route(arn, _body(4000)))

    def test_geo_prefix_is_ignored_on_both_sides(self):
        llm = {**HAIKU, "model_id": "meta.llama3-8b-instruct-v1:0"}
        with _use(llm), _as("RiskAgent"):
            for prefix in (
                "us.",
                "eu.",
                "apac.",
                "jp.",
                "au.",
                "ca.",
                "us-gov.",
                "global.",
            ):
                model_id = f"{prefix}meta.llama3-8b-instruct-v1:0"
                self.assertIn("not allowed", routing.route(model_id, _body(1)))

    def test_null_n_counts_as_one_choice(self):
        body = json.dumps({"max_tokens": 1000, "n": None}).encode()
        self.assertAlmostEqual(
            routing.worst_case_cost(body, HAIKU),
            (len(body) / 4 * 1.0 + 1000 * 5.0) / 1e6,
        )

    def test_body_that_is_not_a_json_object_is_denied_when_a_cap_applies(self):
        with _use(HAIKU), _as("IntentAgent"):
            for body in (b"not json", b"[1, 2]", b"null"):
                reason = routing.route(HAIKU["model_id"], body)
                self.assertTrue(reason.startswith("canyonos denied: "), body)
                self.assertIn("JSON object", reason)

    def test_openai_choices_and_responses_limit_count_toward_the_cap(self):
        body = json.dumps({"max_output_tokens": 1000, "n": 2}).encode()
        self.assertAlmostEqual(
            routing.worst_case_cost(body, HAIKU),
            (len(body) / 4 * 1.0 + 2000 * 5.0) / 1e6,
        )

    def test_missing_max_tokens_falls_back_to_the_models_max_tokens(self):
        self.assertAlmostEqual(
            routing.worst_case_cost(b"{}", HAIKU), (2 / 4 * 1.0 + 1024 * 5.0) / 1e6
        )


class ValidationTests(unittest.TestCase):
    def _assert_invalid(self, llm, *fragments):
        with self.assertRaises(ValueError) as ctx:
            llms.index_llms({"haiku": llm})
        for fragment in fragments:
            self.assertIn(fragment, str(ctx.exception))

    def test_capped_entry_needs_numeric_max_tokens(self):
        missing = {k: v for k, v in HAIKU.items() if k != "max_tokens"}
        self._assert_invalid(missing, "haiku", "max_tokens")
        self._assert_invalid({**HAIKU, "max_tokens": "1024"}, "haiku", "max_tokens")
        self._assert_invalid({**HAIKU, "max_tokens": True}, "haiku", "max_tokens")

    def test_capped_entry_needs_a_price_in_llm_prices(self):
        self._assert_invalid(
            {**HAIKU, "model_id": "no-such-model"}, "haiku", "llm_prices.json"
        )

    def test_cap_must_be_numeric(self):
        self._assert_invalid(
            {**HAIKU, "agents": {"IntentAgent": "0.01"}}, "haiku", "IntentAgent"
        )

    def test_uncapped_entry_needs_no_prices(self):
        llms.index_llms({"a": {"model_id": "m", "agents": {"IntentAgent": None}}})
        llms.index_llms({"b": {"model_id": "m"}})


class RefreshTests(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.object(llms, "llms_by_model_id", {})
        patcher.start()
        self.addCleanup(patcher.stop)
        error_patcher = mock.patch.object(llms, "load_error", None)
        error_patcher.start()
        self.addCleanup(error_patcher.stop)

    def test_refresh_loads_the_published_config(self):
        llms.refresh_llms(
            mock.Mock(get=mock.Mock(return_value=json.dumps({"haiku": HAIKU})))
        )
        self.assertIn("haiku", _loaded_names())

    def test_invalid_refresh_keeps_the_last_good_config(self):
        llms.llms_by_model_id = llms.index_llms({"haiku": HAIKU})
        bad = {"haiku": {**HAIKU, "max_tokens": None}}
        llms.refresh_llms(mock.Mock(get=mock.Mock(return_value=json.dumps(bad))))
        self.assertIn("haiku", _loaded_names())

    def test_first_load_failure_is_named_in_the_denial(self):
        bad = {"haiku": {**HAIKU, "max_tokens": None}}
        with mock.patch.object(llms, "llms_by_model_id", None):
            llms.refresh_llms(mock.Mock(get=mock.Mock(return_value=json.dumps(bad))))
            reason = routing.route(HAIKU["model_id"], _body(1))
        self.assertTrue(reason.startswith("canyonos denied: "))
        self.assertIn("haiku", reason)
        self.assertIn("max_tokens", reason)

    def test_redis_failure_keeps_the_last_config(self):
        llms.llms_by_model_id = llms.index_llms({"haiku": HAIKU})
        llms.refresh_llms(mock.Mock(get=mock.Mock(side_effect=ConnectionError)))
        self.assertIn("haiku", _loaded_names())


class ProxyRequestTests(unittest.TestCase):
    def test_blocked_call_never_reaches_the_provider(self):
        provider = mock.Mock()
        provider.name = "bedrock"
        hooks = mock.Mock()
        hooks._extract_model_id.return_value = HAIKU["model_id"]
        with (
            _use(HAIKU),
            _as("IntentAgent"),
        ):
            app = Flask(__name__)
            with app.test_request_context(method="POST", data=_body(4000)):
                from flask import request

                resp = core.proxy_request(
                    hooks, provider, f"model/{HAIKU['model_id']}/converse", request
                )

        provider.forward.assert_not_called()
        self.assertEqual(resp.status_code, 403)
        self.assertIn("per-request cap", resp.get_json()["message"])


if __name__ == "__main__":
    unittest.main()
