# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Lazily-cached lookups over llm_prices.json's LLM/machine pricing reference data."""

import json
import logging
import os
import re

logger = logging.getLogger(__name__)

DEFAULT_PRICES_PATH = os.path.join(os.path.dirname(__file__), "llm_prices.json")

_token_cost_by_model_id = None
_hourly_cost_by_machine_type = None


def _load_pricing_data(prices_path=DEFAULT_PRICES_PATH):
    """Read llm_prices.json and return (token costs by model id, hourly costs by machine type)."""
    with open(prices_path, "r") as f:
        prices = json.load(f)

    token_costs = {
        model_id: (
            costs["input_cost_per_million_tokens"],
            costs["output_cost_per_million_tokens"],
        )
        for model_id, costs in (prices.get("models") or {}).items()
    }
    machine_costs = dict((prices.get("machines") or {}).items())
    return token_costs, machine_costs


def _load_cache():
    global _token_cost_by_model_id, _hourly_cost_by_machine_type
    if _token_cost_by_model_id is None or _hourly_cost_by_machine_type is None:
        _token_cost_by_model_id, _hourly_cost_by_machine_type = _load_pricing_data()
    return _token_cost_by_model_id, _hourly_cost_by_machine_type


def _candidate_model_ids(model_id):
    """Yield the pricing keys a model id could match, most specific first."""
    yield model_id
    undated = re.sub(r"-\d{4}-?\d{2}-?\d{2}$", "", model_id)
    if undated != model_id:
        yield undated
    if model_id.startswith("gpt-"):
        # Newer OpenAI models reach the table only through their Bedrock ids; the
        # global entry carries OpenAI's own list price, the regional ones a markup.
        for prefix in ("openai.", "global.openai."):
            yield f"{prefix}{model_id}"
            if undated != model_id:
                yield f"{prefix}{undated}"
    if not model_id.startswith("claude-"):
        return
    # Direct-API Anthropic ids carry no vendor prefix or version suffix, and the
    # table is inconsistent about the date segment, so try both spellings.
    yield f"anthropic.{model_id}-v1:0"
    if undated != model_id:
        yield f"anthropic.{undated}-v1:0"


def token_prices(model_id):
    """(input, output) USD per million tokens for model_id, or None if it has no price."""
    if not model_id:
        return None
    token_costs, _ = _load_cache()
    for candidate in _candidate_model_ids(model_id):
        if candidate in token_costs:
            return token_costs[candidate]
    return None


def compute_token_cost(model_id, input_token_count, output_token_count):
    """Return the USD cost of an LLM call, or 0.0 if the model_id is unknown."""
    costs = token_prices(model_id)
    if costs is None:
        return 0.0
    input_cost_per_million, output_cost_per_million = costs
    return (
        input_token_count * input_cost_per_million
        + output_token_count * output_cost_per_million
    ) / 1_000_000


def machine_hourly_cost(machine_type):
    """Return the USD per hour of an EC2 machine type, or 0.0 if it is unknown."""
    _, machine_costs = _load_cache()
    if machine_type not in machine_costs:
        logger.warning(
            "No hourly price for EC2 machine type %s; its server cost is recorded as 0",
            machine_type,
        )
        return 0.0
    return float(machine_costs[machine_type])
