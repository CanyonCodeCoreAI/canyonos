# Scaling policy: decides which agents should gain or lose replicas on each GC poll.

import json
import logging

from canyonos_core.scaling import contract

logger = logging.getLogger(__name__)

# config/scaling.yaml as published by the GC; the dashboard edits it in place.
CONFIG_KEY = "scaling:config"

METRICS = ("queue_length_total", "requests_per_minute_per_replica")


def read_policy(redis_client):
    """The workflow's scaling policy, or None when the document is missing or has none."""
    raw = redis_client.get(CONFIG_KEY) or "{}"
    try:
        document = json.loads(raw)
    except ValueError as e:
        logger.warning("Ignoring %s: not valid JSON (%s)", CONFIG_KEY, e)
        return None
    return document.get("scaling") if isinstance(document, dict) else document


def policy_error(policy):
    """Why a policy is invalid, or None; the same rules the dashboard API enforces."""
    if not isinstance(policy, dict):
        return "a policy must be a mapping"
    for field in ("min_replicas", "max_replicas"):
        value = policy.get(field)
        if not _is_int(value) or value < 1:
            return f"{field} must be an integer >= 1"
    if policy["min_replicas"] > policy["max_replicas"]:
        return "min_replicas must not exceed max_replicas"
    if policy.get("metric") not in METRICS:
        return f"metric must be one of {', '.join(METRICS)}"
    for field in ("scale_up_above", "scale_down_below"):
        value = policy.get(field)
        if not _is_number(value) or not value >= 0:
            return f"{field} must be a number >= 0"
    if policy["scale_down_below"] >= policy["scale_up_above"]:
        return "scale_down_below must be less than scale_up_above"
    return None


def scale(controller):
    """List (agent_name, delta) pairs; one policy applies to every agent, each scaled on its own load."""
    policy = read_policy(controller.redis)
    if policy is None:
        return []
    error = policy_error(policy)
    if error:
        logger.warning("Skipping invalid scaling policy: %s", error)
        return []
    policy = {
        **policy,
        "min_replicas": int(policy["min_replicas"]),
        "max_replicas": int(policy["max_replicas"]),
    }
    decisions = []
    for agent_name, spec in controller.agent_specs.items():
        if spec.get("type", "agent") != "agent":
            continue
        samples = contract.read(controller.redis, contract.agent_key(agent_name))
        if not samples:
            continue
        delta, reason = _decide(policy, samples)
        if delta:
            current = samples[0]["replicas_expected"]
            logger.info(
                "Scaling %s from %d to %d replicas (%s)",
                agent_name,
                current,
                current + delta,
                reason,
            )
            decisions.append((agent_name, delta))
    return decisions


def _decide(policy, samples):
    """One agent's replica change and why: back inside min/max first, then one step when every sample breaches."""
    current = samples[0]["replicas_expected"]
    if current < policy["min_replicas"]:
        return policy[
            "min_replicas"
        ] - current, f"below min_replicas {policy['min_replicas']}"
    if current > policy["max_replicas"]:
        return policy[
            "max_replicas"
        ] - current, f"above max_replicas {policy['max_replicas']}"

    # A full window at one steady replica count doubles as the cooldown after the last change.
    settled = len(samples) >= contract.WINDOW_LENGTH and all(
        s["replicas_expected"] == current and s["replicas_running"] == current
        for s in samples
    )
    if not settled:
        return 0, None

    metric = policy["metric"]
    values = [s.get(metric) for s in samples]
    if not all(_is_number(v) for v in values):
        return 0, None
    low, high = min(values), max(values)
    window = f"{metric} {low:.1f}..{high:.1f} over {len(values)} samples"
    if low > policy["scale_up_above"] and current < policy["max_replicas"]:
        return 1, f"{window}, all > {policy['scale_up_above']}"
    if high < policy["scale_down_below"] and current > policy["min_replicas"]:
        return -1, f"{window}, all < {policy['scale_down_below']}"
    return 0, None


def _is_int(value):
    """A whole number, as the API's zod `.int()` sees it: 3.0 counts, True does not."""
    if isinstance(value, float):
        return value.is_integer()
    return isinstance(value, int) and not isinstance(value, bool)


def _is_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)
