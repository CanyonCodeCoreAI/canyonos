from __future__ import annotations

from canyonos_core.llm_proxy.providers.anthropic import AnthropicProvider
from canyonos_core.llm_proxy.providers.openai import OpenAIProvider

# boto3 ships only in images whose agent declares it, so Bedrock is registered only when present.
try:
    from canyonos_core.llm_proxy.providers.bedrock import BedrockProvider
except ImportError:
    BedrockProvider = None


def build_registry(cfg):
    """Map the URL prefix -> provider instance."""
    registry = {
        "openai": OpenAIProvider(cfg),
        "anthropic": AnthropicProvider(cfg),
    }
    if BedrockProvider is not None:
        registry["bedrock"] = BedrockProvider(cfg)
    return registry
