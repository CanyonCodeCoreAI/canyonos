# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Every governance decision: which calls to an agent are refused and which model its
LLM calls switch to, from `policy.yaml`'s rules and the dashboard-edited
`governance:config`.

Replica images import this file flat, beside `local_controller.py`, so it imports
nothing from `canyonos_core`.
"""

import json
import logging
import time
from dataclasses import dataclass
from datetime import datetime, timezone

POLICY_RULES_KEY = "policy:rules"
CONFIG_KEY = "governance:config"
SPEND_KEY = "governance:spend"
ROUTING_REPLICAS_KEY = "routing_table:replicas"
# Duplicated from canyonos_core.endpoint, which replica images do not carry.
ENDPOINT_AGENT_NAME = "endpoint"
# A replica is down once it misses this many heartbeats, the reconciler's own window.
HEARTBEAT_POLLS = 3
ACTION_KINDS = ("switch_model", "deny")

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Refusal:
    error_name: str
    message: str


@dataclass(frozen=True)
class Rules:
    policy: list
    agents: dict
    spend: dict
    up: frozenset


def _since(value, path):
    """`value` in the UTC form the dashboard API stores and validates:
    `2026-10-20T00:00:00.000Z`."""
    if isinstance(value, datetime):
        instant = value
    elif isinstance(value, str):
        try:
            # Python 3.10's fromisoformat does not take the `Z` suffix.
            instant = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            raise ValueError(
                f"{path}: {value!r} is not an ISO-8601 date-time"
            ) from None
    else:
        raise ValueError(f"{path}: must be an ISO-8601 date-time")
    if instant.tzinfo is None:
        instant = instant.replace(tzinfo=timezone.utc)
    return _utc_text(instant)


def _utc_text(instant):
    return (
        instant.astimezone(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def _spend_rule(rule, path):
    if not isinstance(rule, dict):
        raise ValueError(f"{path}: must be a mapping")
    above_usd = rule.get("above_usd")
    if (
        isinstance(above_usd, bool)
        or not isinstance(above_usd, (int, float))
        or above_usd <= 0
    ):
        raise ValueError(f"{path}.above_usd: must be a positive number")
    action = rule.get("action")
    if not isinstance(action, dict) or action.get("kind") not in ACTION_KINDS:
        raise ValueError(
            f"{path}.action.kind: must be one of {', '.join(ACTION_KINDS)}"
        )
    if action["kind"] == "deny":
        return {"above_usd": above_usd, "action": {"kind": "deny"}}
    model = action.get("model")
    if not isinstance(model, str) or not model:
        raise ValueError(f"{path}.action.model: switch_model needs a model id")
    return {"above_usd": above_usd, "action": {"kind": "switch_model", "model": model}}


def _agent_rules(rules, path):
    if not isinstance(rules, dict):
        raise ValueError(f"{path}: must be a mapping")
    parsed = {}
    if "requires" in rules:
        requires = rules["requires"]
        if not isinstance(requires, list) or not all(
            isinstance(name, str) and name for name in requires
        ):
            raise ValueError(f"{path}.requires: must be a list of agent names")
        parsed["requires"] = list(requires)
    if "spend" in rules:
        spend = rules["spend"]
        if spend is None:
            parsed["spend"] = None
            return parsed
        if not isinstance(spend, dict):
            raise ValueError(f"{path}.spend: must be a mapping")
        if not isinstance(spend.get("rules"), list):
            raise ValueError(f"{path}.spend.rules: must be a list")
        parsed["spend"] = {
            "rules": [
                _spend_rule(rule, f"{path}.spend.rules[{index}]")
                for index, rule in enumerate(spend["rules"])
            ]
        }
        if spend.get("since") is not None:
            parsed["spend"]["since"] = _since(spend["since"], f"{path}.spend.since")
    return parsed


def parse(config):
    """Validate a governance document and return its `agents`, with every `since` in
    the dashboard API's UTC form. Raises ValueError naming the offending path."""
    if not isinstance(config, dict):
        raise ValueError("governance.yaml: must be a mapping with an `agents:` mapping")
    agents = config.get("agents")
    if agents is None:
        return {}
    if not isinstance(agents, dict):
        raise ValueError("governance.yaml: agents: must be a mapping of agent names")
    return {
        name: _agent_rules(rules, f"governance.yaml: agents.{name}")
        for name, rules in agents.items()
    }


def seed(existing, from_yaml, now):
    """Merge `governance.yaml` into the stored document per agent: an agent the store
    already has keeps its rules, a new one gets the file's, its spend counted from
    `now`."""
    agents = dict((existing or {}).get("agents") or {})
    for name, rules in from_yaml.get("agents", {}).items():
        if name in agents:
            continue
        rules = dict(rules)
        if rules.get("spend") is not None and "since" not in rules["spend"]:
            rules["spend"] = {
                **rules["spend"],
                "since": _utc_text(datetime.fromtimestamp(now, timezone.utc)),
            }
        agents[name] = rules
    return {"agents": agents}


def _text(value):
    return value.decode("utf-8") if isinstance(value, bytes) else value


def _spend(raw):
    """Each agent's USD spend; anything unreadable counts as no spend, so no rule trips."""
    try:
        spend = json.loads(raw) if raw else {}
    except ValueError:
        return {}
    if not isinstance(spend, dict):
        return {}
    return {
        name: float(usd)
        for name, usd in spend.items()
        if isinstance(usd, (int, float)) and not isinstance(usd, bool)
    }


def _agents(raw, previous):
    """The stored per-agent rules; unreadable ones keep `previous`'s, so a bad dashboard
    write never drops the policy rules loaded beside them."""
    try:
        return parse(json.loads(raw)) if raw else {}
    except ValueError as exc:
        logger.warning("Keeping the previous governance:config: %s", exc)
        return previous.agents if previous is not None else {}


def _addresses(raw):
    """A routing entry's replica addresses; an unreadable one has none, so its agent
    counts as down."""
    try:
        addresses = json.loads(raw)
    except ValueError:
        return []
    return addresses if isinstance(addresses, list) else []


def _fresh(observed_at, now, poll_interval):
    try:
        return now - float(observed_at) <= HEARTBEAT_POLLS * poll_interval
    except (TypeError, ValueError):
        return False


def load(redis, poll_interval, previous=None):
    """One snapshot of every rule, the published spend, and the agents with a healthy
    replica, from a redis-py client. An unreadable `governance:config` keeps
    `previous`'s agent rules; an unreadable `policy:rules` raises ValueError, and the
    caller keeps its previous snapshot."""
    pipe = redis.pipeline(transaction=False)
    pipe.get(POLICY_RULES_KEY)
    pipe.get(CONFIG_KEY)
    pipe.get(SPEND_KEY)
    pipe.hgetall(ROUTING_REPLICAS_KEY)
    policy_raw, config_raw, spend_raw, routing = pipe.execute()

    policy = json.loads(policy_raw) if policy_raw else []
    agents = _agents(config_raw, previous)

    addresses_by_agent = {
        _text(agent): _addresses(addresses) for agent, addresses in routing.items()
    }
    replicas = [
        (agent, address)
        for agent, addresses in addresses_by_agent.items()
        for address in addresses
    ]
    pipe = redis.pipeline(transaction=False)
    for _, address in replicas:
        pipe.get(f"controller:{address}:status")
        pipe.hget(f"controller:{address}:metrics", "observed_at")
    heartbeats = pipe.execute() if replicas else []

    now = time.time()
    up = set()
    for index, (agent, _) in enumerate(replicas):
        status, observed_at = heartbeats[2 * index], heartbeats[2 * index + 1]
        if _text(status) == "healthy" and _fresh(observed_at, now, poll_interval):
            up.add(agent)

    return Rules(
        policy=policy, agents=agents, spend=_spend(spend_raw), up=frozenset(up)
    )


def _policy_allows(policy, agent, context):
    """The first rule, most specific first, whose `match` the request context meets
    decides; no rules allow everything, no matching rule denies."""
    if agent == ENDPOINT_AGENT_NAME or not policy:
        return True
    for rule in policy:
        if all(
            context.get(key) == value for key, value in rule.get("match", {}).items()
        ):
            access = rule.get("access", [])
            return access == "all" or agent in access
    return False


def _tripped(rules, agent):
    """The spend rule with the highest threshold `agent`'s spend has passed, or None;
    it alone decides, as the dashboard shows it."""
    spend = rules.agents.get(agent, {}).get("spend")
    if not spend:
        return None
    usd = rules.spend.get(agent, 0.0)
    passed = [rule for rule in spend["rules"] if rule["above_usd"] < usd]
    return max(passed, key=lambda rule: rule["above_usd"], default=None)


def _usd(amount):
    return f"{amount:.2f}".rstrip("0").rstrip(".")


def refuse_call(rules, agent, function, context):
    """Why the call to `agent.function` is refused, or None to let it run."""
    if not _policy_allows(rules.policy, agent, context):
        return Refusal(
            "PolicyDenied",
            f"Policy denied the call to {agent}.{function}: no rule in policy.yaml "
            "allows it for this request.",
        )
    for dependency in rules.agents.get(agent, {}).get("requires", []):
        if dependency not in rules.up:
            return Refusal(
                "DependencyDown",
                f"{agent} requires {dependency}, which has no healthy replica right now.",
            )
    tripped = _tripped(rules, agent)
    if tripped is not None and tripped["action"]["kind"] == "deny":
        since = rules.agents[agent]["spend"].get("since", "the deploy")
        return Refusal(
            "SpendLimit",
            f"{agent} is over its ${_usd(tripped['above_usd'])} cap "
            f"(${rules.spend.get(agent, 0.0):.2f} spent since {since}).",
        )
    return None


def model_for(rules, agent):
    """The model `agent`'s LLM calls switch to, when its highest tripped spend rule is
    a `switch_model`; otherwise None."""
    tripped = _tripped(rules, agent)
    if tripped is None or tripped["action"]["kind"] != "switch_model":
        return None
    return tripped["action"]["model"]
