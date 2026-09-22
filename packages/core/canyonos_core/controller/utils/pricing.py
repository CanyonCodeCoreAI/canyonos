"""Lazily-cached lookups over llm_prices.yaml's LLM/instance pricing reference data."""

import os
import re

import yaml

DEFAULT_PRICES_PATH = os.path.join(os.path.dirname(__file__), "llm_prices.yaml")

_token_cost_by_model_id = None
_hourly_cost_by_instance_type = None


def load_pricing_data(prices_path=DEFAULT_PRICES_PATH):
    """Read llm_prices.yaml and return (token costs by model id, hourly costs by instance type)."""
    with open(prices_path, "r") as f:
        prices = yaml.safe_load(f) or {}

    token_costs = {
        model_id: (
            costs["input_cost_per_million_tokens"],
            costs["output_cost_per_million_tokens"],
        )
        for model_id, costs in (prices.get("models") or {}).items()
    }
    instance_costs = dict((prices.get("instances") or {}).items())
    return token_costs, instance_costs


def _load_cache():
    global _token_cost_by_model_id, _hourly_cost_by_instance_type
    if _token_cost_by_model_id is None or _hourly_cost_by_instance_type is None:
        _token_cost_by_model_id, _hourly_cost_by_instance_type = load_pricing_data()
    return _token_cost_by_model_id, _hourly_cost_by_instance_type


def _candidate_model_ids(model_id):
    """Yield the pricing keys a model id could match, most specific first."""
    yield model_id
    undated = re.sub(r"-\d{4}-?\d{2}-?\d{2}$", "", model_id)
    if undated != model_id:
        yield undated
    if not model_id.startswith("claude-"):
        return
    # Direct-API Anthropic ids carry no vendor prefix or version suffix, and the
    # table is inconsistent about the date segment, so try both spellings.
    yield f"anthropic.{model_id}-v1:0"
    if undated != model_id:
        yield f"anthropic.{undated}-v1:0"


def compute_token_cost(model_id, input_token_count, output_token_count):
    """Return the USD cost of an LLM call, or 0.0 if the model_id is unknown."""
    if not model_id:
        return 0.0
    token_costs, _ = _load_cache()
    costs = None
    for candidate in _candidate_model_ids(model_id):
        costs = token_costs.get(candidate)
        if costs is not None:
            break
    if costs is None:
        return 0.0
    input_cost_per_million, output_cost_per_million = costs
    return (
        input_token_count * input_cost_per_million
        + output_token_count * output_cost_per_million
    ) / 1_000_000


def compute_server_cost(instance_type, execution_time_seconds):
    """Return the USD cost of occupying an EC2 instance for execution_time_seconds,
    or 0.0 if the instance_type is unknown."""
    if not instance_type:
        return 0.0
    _, instance_costs = _load_cache()
    hourly_cost = instance_costs.get(instance_type)
    if hourly_cost is None:
        return 0.0
    return float(hourly_cost) * execution_time_seconds / 3600
