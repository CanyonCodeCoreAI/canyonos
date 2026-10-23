# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Single source of truth for the env vars that route an agent's LLM calls through the
in-container LLM gateway (started by LocalController; see canyonos_core/llm_gateway/):
Bedrock calls by their base URL, and every other HTTP(S) call through the gateway's proxy,
which hands OpenAI-format and Anthropic calls to the gateway.

One place that lists the var names and values, used by every replica launch instead of
two independently hand-maintained copies of the same lines.
"""

from canyonos_core.llm_gateway.hooks import GATEWAY_HOST, PROXY_CA_BUNDLE, PROXY_PORT


def _llm_gateway_env_vars(gateway_host: str = GATEWAY_HOST) -> dict:
    """Return the {env_var_name: value} pairs that route Bedrock SDK traffic through the
    in-container LLM gateway at `gateway_host`, and every other HTTP(S) call through its
    proxy.
    """
    return {
        # boto3 (Bedrock)
        "AWS_ENDPOINT_URL_BEDROCK_RUNTIME": f"{gateway_host}/bedrock",
        # Uppercase only: gRPC reads just the lowercase names, so calls between controllers skip it.
        "HTTP_PROXY": f"http://127.0.0.1:{PROXY_PORT}",
        "HTTPS_PROXY": f"http://127.0.0.1:{PROXY_PORT}",
        # boto3 fetches EC2 and ECS credentials from these link-local addresses directly.
        "NO_PROXY": "127.0.0.1,localhost,169.254.169.254,169.254.170.2",
        # The proxy re-encrypts HTTPS calls with its own certificates, which these make clients trust.
        "SSL_CERT_FILE": PROXY_CA_BUNDLE,
        "REQUESTS_CA_BUNDLE": PROXY_CA_BUNDLE,
        "AWS_CA_BUNDLE": PROXY_CA_BUNDLE,
    }


def llm_gateway_docker_env_args(gateway_host: str = GATEWAY_HOST) -> list:
    """Return `_llm_gateway_env_vars` flattened into repeated `-e NAME=VALUE` pairs,
    ready to splice into a `docker run` argument list.
    """
    args = []
    for name, value in _llm_gateway_env_vars(gateway_host).items():
        args.append("-e")
        args.append(f"{name}={value}")
    return args
