# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Lazily-cached lookups over llm_prices.json's LLM/machine pricing reference data."""

import json
import logging
import os
import re

logger = logging.getLogger(__name__)

DEFAULT_PRICES_PATH = os.path.join(os.path.dirname(__file__), "llm_prices.json")
LLM_PRICES_KEY = "llm_prices:models"
# Each Azure OpenAI resource has its own host ending in this, so Azure is listed by it.
AZURE_OPENAI_HOSTS = ".openai.azure.com"
# Every LLM API host the gateway knows, with the prefix LiteLLM's table puts on that
# provider's models; None means they are priced under their plain model id.
LLM_HOSTS = {
    "api.openai.com": None,
    "api.anthropic.com": None,
    "openrouter.ai": None,
    AZURE_OPENAI_HOSTS: "azure",
    "api.together.xyz": "together_ai",
    "api.together.ai": "together_ai",
    "api.fireworks.ai": "fireworks_ai",
    "inference.baseten.co": "baseten",
    "api.x.ai": "xai",
    "api.moonshot.ai": "moonshot",
    "api.deepinfra.com": "deepinfra",
    "api.groq.com": "groq",
    "api.mistral.ai": "mistral",
    "api.cerebras.ai": "cerebras",
    "api.deepseek.com": "deepseek",
    "generativelanguage.googleapis.com": "gemini",
    "ai-gateway.vercel.sh": "vercel_ai_gateway",
    "api.perplexity.ai": "perplexity",
    "api.sambanova.ai": "sambanova",
    "api.hyperbolic.xyz": "hyperbolic",
    "api.z.ai": "zai",
    "api.lambda.ai": "lambda_ai",
}


def llm_host(host):
    """The LLM_HOSTS entry a host falls under, or None if it is not a known LLM API host."""
    if host and host.endswith(AZURE_OPENAI_HOSTS):
        return AZURE_OPENAI_HOSTS
    return host if host in LLM_HOSTS else None


_token_cost_by_model_id = None
_hourly_cost_by_machine_type = None
_unpriced_model_ids = set()


def _load_pricing_data(prices_path=DEFAULT_PRICES_PATH):
    """Read llm_prices.json and return (token costs by model id, hourly costs by machine type)."""
    with open(prices_path, "r") as f:
        prices = json.load(f)

    machine_costs = dict((prices.get("machines") or {}).items())
    return _token_costs(prices.get("models") or {}), machine_costs


def _token_costs(models):
    """(input, output, cache read, cache write) USD per million tokens keyed by model id,
    from llm_prices.json's `models:` shape; a missing cache price is the input price."""
    return {
        model_id: (
            costs["input_cost_per_million_tokens"],
            costs["output_cost_per_million_tokens"],
            costs.get(
                "cache_read_cost_per_million_tokens",
                costs["input_cost_per_million_tokens"],
            ),
            costs.get(
                "cache_write_cost_per_million_tokens",
                costs["input_cost_per_million_tokens"],
            ),
        )
        for model_id, costs in models.items()
    }


def _load_cache():
    global _token_cost_by_model_id, _hourly_cost_by_machine_type
    if _token_cost_by_model_id is None or _hourly_cost_by_machine_type is None:
        _token_cost_by_model_id, _hourly_cost_by_machine_type = _load_pricing_data()
    return _token_cost_by_model_id, _hourly_cost_by_machine_type


def add_prices(models):
    """Put `models:`-shaped prices over llm_prices.json's, for this process only."""
    token_costs, _ = _load_cache()
    token_costs.update(_token_costs(models))


def load_published_prices(redis):
    """Add the LiteLLM prices the global controller published to Redis, keeping only
    llm_prices.json's if there are none or they can't be read."""
    try:
        raw = redis.get(LLM_PRICES_KEY)
        if raw:
            add_prices(json.loads(raw))
    except Exception as e:
        logger.warning(
            "Failed to load %s; using llm_prices.json alone: %s", LLM_PRICES_KEY, e
        )


def _candidate_model_ids(model_id, prefix=None):
    """Yield the pricing keys a model id could match, most specific first; `prefix` is
    LiteLLM's prefix for the provider that served the call."""
    if prefix:
        yield f"{prefix}/{model_id}"
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


def token_prices(model_id, prefix=None):
    """(input, output, cache read, cache write) USD per million tokens for model_id under
    LiteLLM's provider `prefix`, or None if it has no price."""
    if not model_id:
        return None
    token_costs, _ = _load_cache()
    for candidate in _candidate_model_ids(model_id, prefix):
        if candidate in token_costs:
            return token_costs[candidate]
    return None


def compute_token_cost(
    model_id,
    input_token_count,
    output_token_count,
    cache_read_token_count=0,
    cache_write_token_count=0,
    prefix=None,
):
    """Return the USD cost of an LLM call served by LiteLLM's provider `prefix`, or 0.0 if
    the model_id is unknown. The cache token counts are the part of input_token_count read
    from or written to the cache."""
    costs = token_prices(model_id, prefix)
    if costs is None:
        key = f"{prefix}/{model_id}" if prefix else model_id
        if key not in _unpriced_model_ids:
            _unpriced_model_ids.add(key)
            logger.warning("No price for model %s; its calls cost $0", key)
        return 0.0
    input_price, output_price, cache_read_price, cache_write_price = costs
    uncached_input = (
        input_token_count - cache_read_token_count - cache_write_token_count
    )
    return (
        uncached_input * input_price
        + cache_read_token_count * cache_read_price
        + cache_write_token_count * cache_write_price
        + output_token_count * output_price
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
