"""Entry point: ``python -m llm_gateway``."""

from __future__ import annotations

import logging

from canyonos_core.llm_gateway.app import create_app
from canyonos_core.llm_gateway.config import Config


def main() -> None:
    """Start the LLM gateway: a local server that passes an agent's LLM calls on to the
    provider and records their token usage. The Local Controller starts one inside
    every replica."""
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    cfg = Config.from_env()
    app = create_app(cfg)
    logging.getLogger("llm_gateway").info(
        "llm_gateway on http://%s:%d  (openai=%s, anthropic=%s, bedrock=%s [%s])",
        cfg.host,
        cfg.port,
        cfg.openai.upstream_base,
        cfg.anthropic.upstream_base,
        cfg.bedrock_upstream_host,
        cfg.bedrock_region,
    )
    # threaded so concurrent callers don't serialize; dev server is fine for a
    # local gateway.
    app.run(host=cfg.host, port=cfg.port, threaded=True)


if __name__ == "__main__":
    main()
