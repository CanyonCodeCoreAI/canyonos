# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Best-effort fetch of current per-model token costs from an external catalog."""

import logging

import requests

logger = logging.getLogger(__name__)

LITELLM_PRICING_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"
REQUEST_TIMEOUT_SECONDS = 5
CACHE_COST_KEYS = {
    "cache_read_input_token_cost": "cache_read_cost_per_million_tokens",
    "cache_creation_input_token_cost": "cache_write_cost_per_million_tokens",
}


def litellm_prices(source_url=LITELLM_PRICING_URL):
    """Prices for every model with a per-token price in source_url, keyed by LiteLLM's model
    id, in llm_prices.json's `models:` shape. Returns {} on any failure, since it runs on
    every global controller startup."""
    try:
        response = requests.get(source_url, timeout=REQUEST_TIMEOUT_SECONDS)
        response.raise_for_status()
        models = {}
        for model_id, remote in response.json().items():
            if not isinstance(remote, dict):
                continue
            input_cost = remote.get("input_cost_per_token")
            output_cost = remote.get("output_cost_per_token")
            if not isinstance(input_cost, (int, float)) or not isinstance(
                output_cost, (int, float)
            ):
                continue
            costs = {
                "input_cost_per_million_tokens": input_cost * 1_000_000,
                "output_cost_per_million_tokens": output_cost * 1_000_000,
            }
            for remote_key, local_key in CACHE_COST_KEYS.items():
                if isinstance(remote.get(remote_key), (int, float)):
                    costs[local_key] = remote[remote_key] * 1_000_000
            models[model_id] = costs
        return models
    except Exception:
        logger.warning("LLM price fetch from %s failed.", source_url, exc_info=True)
        return {}
