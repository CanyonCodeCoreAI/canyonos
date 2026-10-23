# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

# Intent Agent
#
# Stage 0. Turns a free-text portfolio request into the structured input the
# rest of the pipeline needs:
#
#   "Analyze 40% Apple, 35% Microsoft and 25% Nvidia over the last 6 months"
#      ->  {"holdings": {"AAPL": 0.4, "MSFT": 0.35, "NVDA": 0.25},
#           "lookback_days": 180}
#
# Calls a Baseten Model API through the openai SDK -- same pattern as
# AdvisorAgent. Token telemetry is recorded onto this execution's
# future:<future_id> hash transparently by the CanyonOS LLM gateway, which each
# agent container's Baseten calls are routed through, hardcoded base_url and all.
# Configure with env vars:
#   BASETEN_API_KEY   (required)
#   BASETEN_MODEL_ID  (default: deepseek-ai/DeepSeek-V4-Flash-0731)
#
# If the LLM is unavailable or returns unparseable output, parse() raises:
# there is no fallback, the request fails loudly rather than guessing at the
# holdings. Weights are renormalized to 1.0.
#
# The instructions are the IntentAgent.parse system prompt in config/prompts.yaml, which the
# LLM gateway adds to every chat completion.
#
# Resource profile: cheap CPU, single call per request, on the critical path
# before the fan-out.

import os
import re
import json

from openai import OpenAI

DEFAULT_LOOKBACK_DAYS = 365


class IntentAgent(object):
    def __init__(self):
        self.tools = [self.parse]
        self.model_id = os.environ.get(
            "BASETEN_MODEL_ID", "deepseek-ai/DeepSeek-V4-Flash-0731"
        )
        self._client = OpenAI(
            base_url="https://inference.baseten.co/v1",
            api_key=os.environ["BASETEN_API_KEY"],
        )

    def parse(self, query: str) -> dict:
        """Parse a natural-language portfolio request into holdings + lookback."""
        response = self._client.chat.completions.create(
            model=self.model_id,
            messages=[{"role": "user", "content": self._build_prompt(query)}],
            temperature=0.0,
        )
        text = response.choices[0].message.content
        if not text:
            raise ValueError("IntentAgent: LLM returned no output for the request.")

        parsed = self._extract_json(text)
        if parsed is None:
            raise ValueError(
                f"IntentAgent: could not parse holdings from LLM output: {text!r}"
            )

        result = self._sanitize(parsed)
        if not result["holdings"]:
            raise ValueError(
                f"IntentAgent: no valid holdings found in request: {query!r}"
            )
        return result

    def _build_prompt(self, query: str) -> str:
        return f'Request: "{query}"\n\nJSON:'

    def _extract_json(self, text: str):
        """Pull the first JSON object out of the model's response text."""
        # Models sometimes wrap the JSON in prose or code fences; grab the
        # outermost {...} span.
        match = re.search(r"\{.*\}", text, re.DOTALL)
        if not match:
            return None
        try:
            return json.loads(match.group(0))
        except (ValueError, TypeError):
            return None

    def _sanitize(self, parsed: dict) -> dict:
        """Validate types and renormalize weights to sum to 1.0."""
        raw = (parsed or {}).get("holdings") or {}
        holdings = {}
        for ticker, weight in raw.items():
            try:
                w = float(weight)
            except (ValueError, TypeError):
                continue
            if w > 0:
                holdings[str(ticker).upper()] = w

        total = sum(holdings.values())
        if total > 0:
            holdings = {t: round(w / total, 4) for t, w in holdings.items()}

        try:
            lookback = int((parsed or {}).get("lookback_days", DEFAULT_LOOKBACK_DAYS))
        except (ValueError, TypeError):
            lookback = DEFAULT_LOOKBACK_DAYS
        if lookback <= 0:
            lookback = DEFAULT_LOOKBACK_DAYS

        return {"holdings": holdings, "lookback_days": lookback}


if __name__ == "__main__":
    agent = IntentAgent()
    print(
        agent.parse(
            query="Analyze 40% Apple, 35% Microsoft and 25% Nvidia over the last 6 months"
        )
    )
