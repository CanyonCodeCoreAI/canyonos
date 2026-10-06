"""Sets the system prompt of each LLM call from the project's prompts.yaml."""

from __future__ import annotations

import json
import logging

log = logging.getLogger("llm_gateway")

PROMPTS_CONFIG_KEY = "prompts:config"

_current_by_name: dict = {}


def refresh_prompts(redis) -> None:
    """Reload every prompt's live version from Redis, keeping the last on failure."""
    global _current_by_name
    try:
        raw = redis.get(PROMPTS_CONFIG_KEY)
        _current_by_name = (json.loads(raw) if raw else {}).get("prompts") or {}
    except Exception as e:
        log.warning(
            "Failed to refresh %s; keeping the last prompts: %s", PROMPTS_CONFIG_KEY, e
        )


def apply(provider, name: str, subpath: str, body: bytes) -> tuple[bytes, str | None]:
    """The request body with the named prompt as its system prompt, and the version used.

    Returns the body unchanged and no version when there is no such prompt, the request has
    no JSON object body, or the provider has nowhere to put a system prompt on this call.
    """
    current = _current_by_name.get(name)
    if current is None or not body:
        return body, None
    try:
        params = json.loads(body)
    except ValueError:
        return body, None
    if not isinstance(params, dict) or not provider.set_system(
        params, subpath, current["content"]
    ):
        return body, None
    return json.dumps(params).encode(), str(current["version"])
