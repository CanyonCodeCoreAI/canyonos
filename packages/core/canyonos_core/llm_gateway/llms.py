"""Loads llms.yaml from Redis: the models each agent may use and their per-request cost caps."""

from __future__ import annotations

import json
import logging
from typing import Optional

from canyonos_core.llm_gateway import pricing

log = logging.getLogger("llm_gateway")

LLMS_CONFIG_KEY = "llms:config"

GEO_PREFIXES = ("us-gov.", "us.", "eu.", "apac.", "jp.", "au.", "ca.", "global.")
ARN_RESOURCE_MARKERS = ("foundation-model/", "inference-profile/")

# None until the first successful load, so calls are refused rather than let through unchecked.
llms_by_model_id: Optional[dict] = None
load_error: Optional[str] = None


def refresh_llms(redis) -> None:
    global llms_by_model_id, load_error
    try:
        raw = redis.get(LLMS_CONFIG_KEY)
        llms_by_model_id = index_llms(json.loads(raw) if raw else {})
        load_error = None
    except Exception as e:
        load_error = str(e)
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
    if not _is_number(llm.get("max_tokens")):
        raise ValueError(
            f"llms.yaml entry {name}: max_tokens must be a number to enforce a cap"
        )
    if pricing.token_prices(normalize_model_id(llm["model_id"])) is None:
        raise ValueError(
            f"llms.yaml entry {name}: {llm['model_id']} has no price in llm_prices.json "
            "to enforce a cap"
        )
    for agent, cap in caps:
        if cap is not None and not _is_number(cap):
            raise ValueError(
                f"llms.yaml entry {name}: cap for {agent} must be a number, got {cap!r}"
            )


def _is_number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)
