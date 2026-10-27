# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Blocks proxied calls to a model this agent isn't allowed to use, or that could cost more than its cap."""

from __future__ import annotations

import json
import os
import threading
import time
from typing import Optional

from canyonos_core.llm_gateway import llms, pricing, prompts
from canyonos_core.llm_gateway.providers.base import GatewayResponse

AGENT_NAME = os.environ.get("CANYONOS_AGENT_NAME")
REFRESH_SECONDS = 5
# Rough bytes-per-token ratio, so input tokens are estimated without asking the provider.
BYTES_PER_TOKEN = 4


def start_refresh(redis) -> None:
    """Load LLM prices once, and llms.yaml and prompts.yaml now and then in the background,
    from Redis."""

    def loop():
        while True:
            time.sleep(REFRESH_SECONDS)
            refresh(redis)

    pricing.load_published_prices(redis)
    refresh(redis)
    threading.Thread(target=loop, name="llms-config-refresh", daemon=True).start()


def refresh(redis) -> None:
    """Reload llms.yaml and prompts.yaml from Redis."""
    llms.refresh_llms(redis)
    prompts.refresh_prompts(redis)


def route(model_id: str, body: bytes, prefix: Optional[str] = None) -> Optional[str]:
    """Why this agent's call to model_id, served by LiteLLM's provider `prefix`, is refused,
    or None to let it through."""
    if llms.llms_by_model_id is None:
        return (
            "LLM calls are blocked: CanyonOS could not load llms.yaml yet "
            f"(it retries every {REFRESH_SECONDS}s)."
        )
    llm = llms.llms_by_model_id.get(llms.normalize_model_id(model_id))
    if not llm or "agents" not in llm:
        return None

    agents = llm["agents"] or {}
    if AGENT_NAME not in agents:
        return f"canyonos denied: {AGENT_NAME} is not allowed to use {llm['name']}"

    cap = agents[AGENT_NAME]
    if cap is None:
        return None
    if pricing.token_prices(llms.normalize_model_id(llm["model_id"]), prefix) is None:
        return (
            f"canyonos denied: {AGENT_NAME} has a per-request cap on {llm['name']}, "
            "but CanyonOS has no price for it at the provider serving this call, so the "
            "cap can't be checked; remove the cap in llms.yaml"
        )
    try:
        cost = worst_case_cost(body, llm, prefix)
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


def worst_case_cost(body: bytes, llm: dict, prefix: Optional[str] = None) -> float:
    """USD cost, at LiteLLM's provider `prefix`, if the call used every output token it is
    allowed."""
    input_tokens = len(body) / BYTES_PER_TOKEN
    payload = json.loads(body)
    if not isinstance(payload, dict):
        raise ValueError("body is not a JSON object")
    output_tokens = (_requested_max_tokens(payload) or llm["max_tokens"]) * (
        payload.get("n") or 1
    )
    return pricing.compute_token_cost(
        llms.normalize_model_id(llm["model_id"]),
        input_tokens,
        output_tokens,
        prefix=prefix,
    )


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
