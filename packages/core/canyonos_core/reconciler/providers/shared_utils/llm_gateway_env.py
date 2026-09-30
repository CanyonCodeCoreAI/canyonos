"""Single source of truth for the env vars that route an agent's LLM SDK calls
through the in-container LLM gateway (started by LocalController; see
canyonos_core/llm_gateway/).

Every LLM SDK/library reads a different env var name for its base URL -- there
is no universal name to standardize on, so all of them still have to be set.
What this module collapses is the VALUE: one GATEWAY_HOST constant, one place
that lists the var names, used by both the Local and EC2 runtime backends
instead of two independently hand-maintained copies of the same six lines.

See company-memory: "LLM gateway can infer the provider from the request; the
six base-URL variable names still cannot be collapsed" (CAN-343 analysis).
"""

# The gateway always runs on localhost inside the agent's own container.
GATEWAY_HOST = "http://127.0.0.1:8081"


def _llm_gateway_env_vars(gateway_host: str = GATEWAY_HOST) -> dict:
    """Return the {env_var_name: value} pairs that route Bedrock/OpenAI/Anthropic
    SDK traffic through the in-container LLM gateway at `gateway_host`.
    """
    return {
        # boto3 (Bedrock)
        "AWS_ENDPOINT_URL_BEDROCK_RUNTIME": f"{gateway_host}/bedrock",
        # openai SDK
        "OPENAI_BASE_URL": f"{gateway_host}/openai/v1",
        # langchain_openai / llama_index
        "OPENAI_API_BASE": f"{gateway_host}/openai/v1",
        # anthropic SDK
        "ANTHROPIC_BASE_URL": f"{gateway_host}/anthropic",
        # langchain_anthropic
        "ANTHROPIC_API_URL": f"{gateway_host}/anthropic",
        # LiteLLM
        "ANTHROPIC_API_BASE": f"{gateway_host}/anthropic",
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
