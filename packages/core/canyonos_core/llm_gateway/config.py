# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Configuration, read once from the environment at startup.

OpenAI-format and Anthropic calls carry the agent's own key through.
"""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass
class Config:
    """The LLM gateway's settings: where it listens, where it forwards Bedrock calls, and
    the Redis it writes telemetry to."""

    host: str
    port: int
    connect_timeout: float
    read_timeout: float

    bedrock_region: str
    bedrock_upstream_host: str

    redis_host: str
    redis_port: int

    @classmethod
    def from_env(cls) -> "Config":
        """Build the settings from environment variables, defaulting anything unset."""
        region = (
            os.getenv("BEDROCK_REGION")
            or os.getenv("AWS_REGION")
            or os.getenv("AWS_DEFAULT_REGION")
            or "us-east-1"
        )
        return cls(
            host=os.getenv("GATEWAY_HOST", "127.0.0.1"),
            port=int(os.getenv("GATEWAY_PORT", "8080")),
            connect_timeout=float(os.getenv("GATEWAY_CONNECT_TIMEOUT", "10")),
            read_timeout=float(os.getenv("GATEWAY_READ_TIMEOUT", "600")),
            bedrock_region=region,
            bedrock_upstream_host=os.getenv(
                "BEDROCK_UPSTREAM_HOST", f"bedrock-runtime.{region}.amazonaws.com"
            ),
            redis_host=os.getenv("CANYONOS_REDIS_HOST", "localhost"),
            redis_port=int(os.getenv("CANYONOS_REDIS_PORT", "6379")),
        )
