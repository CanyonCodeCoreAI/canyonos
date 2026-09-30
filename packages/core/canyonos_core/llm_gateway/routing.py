"""Blocks proxied calls to a model this agent isn't allowed to use, or that could cost more than its cap."""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from typing import Optional

from canyonos_core.llm_gateway.providers.base import GatewayResponse

log = logging.getLogger("llm_gateway")

AGENT_NAME = os.environ.get("CANYONOS_AGENT_NAME")
LLMS_CONFIG_KEY = "llms:config"
REFRESH_SECONDS = 5
# Rough bytes-per-token ratio, so input tokens are estimated without asking the provider.
BYTES_PER_TOKEN = 4

GEO_PREFIXES = ("us-gov.", "us.", "eu.", "apac.", "jp.", "au.", "ca.", "global.")
ARN_RESOURCE_MARKERS = ("foundation-model/", "inference-profile/")

# None until the first successful load, so calls are refused rather than let through unchecked.
_llms_by_model_id: Optional[dict] = None
_load_error: Optional[str] = None


def start_refresh(redis) -> None:
    """Load llms.yaml from Redis now, then keep it current in the background."""
    _refresh(redis)

    def loop():
        while True:
            time.sleep(REFRESH_SECONDS)
            _refresh(redis)

    threading.Thread(target=loop, name="llms-config-refresh", daemon=True).start()


def _refresh(redis) -> None:
    global _llms_by_model_id, _load_error
    try:
        raw = redis.get(LLMS_CONFIG_KEY)
        _llms_by_model_id = index_llms(json.loads(raw) if raw else {})
        _load_error = None
    except Exception as e:
        _load_error = str(e)
        log.warning(
            "Failed to refresh %s; keeping the last config: %s", LLMS_CONFIG_KEY, e
        )


def normalize_model_id(model_id: str) -> str:
    """The bare model id behind a Bedrock ARN or cross-region inference profile id."""
    for marker in ARN_RESOURCE_MARKERS:
        if model_id.startswith("arn:") and marker in model_id:
            model_id = model_id.split(marker, 1)[1]
            break
    for prefix in GEO_PREFIXES:
        if model_id.startswith(prefix):
            return model_id[len(prefix) :]
    return model_id


def index_llms(llms) -> dict:
    """Key each llms.yaml entry by its normalized model_id, keeping its name."""
    indexed = {}
    for name, llm in llms.items():
        if isinstance(llm, dict) and llm.get("model_id"):
            _validate_priced_entry(name, llm)
            indexed[normalize_model_id(llm["model_id"])] = {**llm, "name": name}
    return indexed


def _validate_priced_entry(name: str, llm: dict) -> None:
    """Raise ValueError if an entry with a cap lacks the numbers needed to price a call."""
    caps = (llm.get("agents") or {}).items()
    if all(cap is None for _, cap in caps):
        return
    for field in ("input_cost_per_1m", "output_cost_per_1m", "max_tokens"):
        if not _is_number(llm.get(field)):
            raise ValueError(
                f"llms.yaml entry {name}: {field} must be a number to enforce a cap"
            )
    for agent, cap in caps:
        if cap is not None and not _is_number(cap):
            raise ValueError(
                f"llms.yaml entry {name}: cap for {agent} must be a number, got {cap!r}"
            )


def _is_number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def route(model_id: str, body: bytes) -> Optional[str]:
    """Why this agent's call to model_id is refused, or None to let it through."""
    if _llms_by_model_id is None:
        detail = f": {_load_error}" if _load_error else " yet"
        return f"canyonos denied: {LLMS_CONFIG_KEY} has not loaded{detail}"
    llm = _llms_by_model_id.get(normalize_model_id(model_id))
    if not llm or "agents" not in llm:
        return None

    agents = llm["agents"] or {}
    if AGENT_NAME not in agents:
        return f"canyonos denied: {AGENT_NAME} is not allowed to use {llm['name']}"

    cap = agents[AGENT_NAME]
    if cap is None:
        return None
    try:
        cost = worst_case_cost(body, llm)
    except ValueError:
        return (
            f"canyonos denied: {AGENT_NAME} has a per-request cap on {llm['name']}, "
            "so the request body must be a JSON object"
        )
    if cost > cap:
        return (
            f"canyonos denied: {AGENT_NAME} call to {llm['name']} could cost up to "
            f"${cost:.4f}, over its ${cap} per-request cap"
        )
    return None


def worst_case_cost(body: bytes, llm: dict) -> float:
    """USD cost if the call used every output token it is allowed."""
    input_tokens = len(body) / BYTES_PER_TOKEN
    payload = json.loads(body)
    if not isinstance(payload, dict):
        raise ValueError("body is not a JSON object")
    output_tokens = (_requested_max_tokens(payload) or llm["max_tokens"]) * (
        payload.get("n") or 1
    )
    return (
        input_tokens * llm["input_cost_per_1m"]
        + output_tokens * llm["output_cost_per_1m"]
    ) / 1_000_000


def _requested_max_tokens(payload: dict) -> Optional[int]:
    """The output-token limit the caller set, in OpenAI, Anthropic or Bedrock Converse form."""
    return (
        payload.get("max_tokens")
        or payload.get("max_completion_tokens")
        or payload.get("max_output_tokens")
        or (payload.get("inferenceConfig") or {}).get("maxTokens")
    )


def denied_response(reason: str) -> GatewayResponse:
    """A 403 that the OpenAI, Anthropic and boto3 clients all surface with the reason."""
    body = {
        "message": reason,
        "error": {"type": "llm_policy_blocked", "message": reason},
    }
    return GatewayResponse(
        status=403,
        headers=[
            ("Content-Type", "application/json"),
            ("x-amzn-ErrorType", "AccessDeniedException"),
        ],
        content=json.dumps(body).encode("utf-8"),
    )
