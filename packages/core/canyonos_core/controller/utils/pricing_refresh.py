"""Best-effort refresh of llm_prices.json's per-model token costs from an external catalog."""

import json
import logging

import requests

from canyonos_core.llm_gateway import pricing

logger = logging.getLogger(__name__)

LITELLM_PRICING_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"
REQUEST_TIMEOUT_SECONDS = 5


def refresh_llm_prices(
    prices_path=pricing.DEFAULT_PRICES_PATH, source_url=LITELLM_PRICING_URL
):
    """Refresh the `models:` entries in prices_path from source_url's per-token costs.

    Only updates model ids already present in the file -- never adds or removes keys,
    and never touches `instances:`. Returns True if the file was rewritten, False on
    any failure (network, bad response, no matches) or if nothing changed -- this must
    never raise, since it runs unconditionally on every global controller startup.
    """
    try:
        response = requests.get(source_url, timeout=REQUEST_TIMEOUT_SECONDS)
        response.raise_for_status()
        remote_prices = response.json()

        with open(prices_path, "r") as f:
            local_prices = json.load(f)
        models = local_prices.get("models") or {}

        updated = []
        for model_id, costs in models.items():
            remote = remote_prices.get(model_id)
            if not isinstance(remote, dict):
                continue
            input_cost = remote.get("input_cost_per_token")
            output_cost = remote.get("output_cost_per_token")
            if not isinstance(input_cost, (int, float)) or not isinstance(
                output_cost, (int, float)
            ):
                continue
            costs["input_cost_per_million_tokens"] = input_cost * 1_000_000
            costs["output_cost_per_million_tokens"] = output_cost * 1_000_000
            updated.append(model_id)

        if not updated:
            logger.info(
                "LLM price refresh: no matching models found in %s; leaving %s as-is.",
                source_url,
                prices_path,
            )
            return False

        with open(prices_path, "w") as f:
            f.write(json.dumps(local_prices, indent=2) + "\n")

        logger.info(
            "LLM price refresh: updated %d/%d model(s) in %s from %s.",
            len(updated),
            len(models),
            prices_path,
            source_url,
        )
        return True
    except Exception:
        logger.warning(
            "LLM price refresh from %s failed; keeping existing %s.",
            source_url,
            prices_path,
            exc_info=True,
        )
        return False
