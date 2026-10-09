# LLM Gateway

Every model call an agent makes goes through the LLM gateway that runs next to it. The
gateway can limit which agents may use a model and how much a single call may cost.
Without any setup, every agent can call every model.

Every agent and workflow container runs its own copy of `llm_gateway`. OpenAI,
Anthropic and Bedrock calls from your code go through it, which is how
CanyonOS collects token usage and cost per request without changing the
calling code.

## Defining models

Create an `llms.yaml` file in the project's config folder. Each entry names a model
and lists the agents allowed to use it:

```yaml
haiku:
  model_id: us.anthropic.claude-haiku-4-5-20251001-v1:0
  max_tokens: 1024
  agents:
    IntentAgent: 0.01
    AdvisorAgent:
```

- **Name** (`haiku`): your own label for the model. It shows in refusal messages.
- **model_id**: the model ID the agent sends to the provider.
- **max_tokens**: the most output tokens to assume when a call doesn't set its own
  limit.
- **agents**: the agents allowed to call this model, each with the most one call may
  cost, in US dollars. Leave the value empty for no cap, like `AdvisorAgent` above.

## What gets blocked

For each call, the gateway looks up the model by its `model_id`:

- **The model isn't in `llms.yaml`, or its entry has no `agents` list**: any agent can
  call it.
- **The agent isn't in the model's `agents` list**: the call is refused.
- **The call could cost more than the agent's cap**: the call is refused.

A refused call never reaches the provider. The agent gets a 403 error with the
reason, which the OpenAI, Anthropic and AWS clients all show as an error.

## How cost is checked

The gateway checks a call's cost before sending it, so it uses the most the call
could cost:

- **Input**: the size of the request, at about 4 bytes per token.
- **Output**: the output-token limit the call sets. If the call sets none, the
  model's `max_tokens` is used instead. A call that asks for several answers counts
  each one.

A call is refused when that cost is over the cap, even if the real answer would have
been shorter.

## How changes reach the gateway

When the Global Controller starts or reloads, it publishes `llms.yaml` to each
machine's Redis. Each gateway reads it at startup and again every 5 seconds, so a reload
takes effect within a few seconds. Until the gateway has read it once, it refuses every
call.

## Model prices

Prices come from CanyonOS's own price list,
`packages/core/canyonos_core/llm_gateway/llm_prices.json`. The same list is used to
check caps and to report spend on the dashboard. A model with a cap must have a price
there, or the gateway rejects `llms.yaml`.

## Where it runs

The local controller inside each container starts the gateway as a subprocess
bound to `127.0.0.1:8081`. The boot log prints `Started LLM gateway on
127.0.0.1:8081 (PID: n)`. There is no gateway on your machine and no shared
gateway between containers. This is the same on EC2.

On the host, 8081 is the local dashboard by default. `host.docker.internal`
resolves inside the containers, but the dashboard only listens on loopback,
so pointing an SDK at `host.docker.internal:8081` reaches nothing.

## How calls get there

The runtime sets six variables on every container with `docker run -e`:

| Variable | Value | Read by |
|---|---|---|
| `AWS_ENDPOINT_URL_BEDROCK_RUNTIME` | `http://127.0.0.1:8081/bedrock` | boto3 |
| `OPENAI_BASE_URL` | `http://127.0.0.1:8081/openai/v1` | openai SDK |
| `OPENAI_API_BASE` | `http://127.0.0.1:8081/openai/v1` | langchain_openai, llama_index |
| `ANTHROPIC_BASE_URL` | `http://127.0.0.1:8081/anthropic` | anthropic SDK |
| `ANTHROPIC_API_URL` | `http://127.0.0.1:8081/anthropic` | langchain_anthropic |
| `ANTHROPIC_API_BASE` | `http://127.0.0.1:8081/anthropic` | LiteLLM |

Docker applies `-e` after `--env-file`, so a value in your `.env` cannot
override these. You do not need to write them anywhere, and writing them does
nothing. The "Read by" column is the platform's own note on which library
reads which name; it is not checked against those libraries here.

The same mechanism means you cannot point an agent at Azure OpenAI, vLLM,
Ollama or OpenRouter from the agent's environment. The gateway reads its
upstream from `OPENAI_UPSTREAM_BASE` and `ANTHROPIC_UPSTREAM_BASE` and
defaults to the real providers. Because the gateway inherits the container
environment, setting one of those in the `env_file` redirects the upstream.

The gateway does not convert providers. Request body, model id and response
parsing pass through as your code wrote them.

## What goes in `.env`

The gateway takes its upstream key from the container environment:
`OPENAI_API_KEY` and `ANTHROPIC_API_KEY`, and the usual AWS credentials for
Bedrock. The `env_file` in the manifest is how those reach the container.

An empty `OPENAI_API_KEY=` line is not the same as no line. The gateway sees an
empty key, forwards the call with no `Authorization` header, and the provider
answers 401. Leave the line out until you have a key.

Your code may still need a placeholder key of its own. The openai and
anthropic SDKs refuse to construct a client without one. The gateway strips the
caller's `Authorization` and `x-api-key` headers and inserts its own key, so
any non-empty value works.

For Bedrock, botocore signs requests even when the endpoint is overridden, so
a caller may need placeholder AWS credentials. The gateway re-issues the call
upstream with its own identity.

## Code that ignores environment variables

An SDK client built with an explicit `base_url=` argument, or a request made
by hand against a hardcoded `https://api.openai.com/...`, never reads any of
the six variables and goes straight to the provider. Grep for
`api.openai.com` and `api.anthropic.com` in the source to find those. Inside
the `.car/app` copy, the fix is to read the variable with the original as
the default:

```python
import os

API = (
    os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
    + "/responses"
)
```

Only the address changes. Outside a CanyonOS container the module behaves as
before.

## Confirming the route

The gateway logs every call it forwards, with the logger name `llm_gateway`, an
arrow, the provider, the method and path, and the model:

```bash
docker logs <container> 2>&1 | grep 'llm_gateway: [→←]'
```

A completed request with no such line went to the provider directly. The
older recipe `grep -E "LLM gateway|8081"` only matches the boot line.

`curl http://127.0.0.1:8081/healthz` from inside the container returns the
registered providers. It says nothing about whether the upstream key is
valid. Bedrock is registered only when the image can import `boto3`, which
the build adds when your code imports it.

## Supported call shapes

- OpenAI and Anthropic non-streaming calls are buffered and forwarded.
- OpenAI and Anthropic streaming calls work. When the upstream answers with
  `text/event-stream`, the gateway relays it chunk by chunk as it arrives, so
  `.stream()`, `.astream()` and a raw `stream=True` all read token by token.
  If the upstream fails mid-stream, the gateway aborts the response instead of
  ending it cleanly, so the caller sees an error rather than a truncated
  answer.
- Bedrock `invoke`, `converse`, `invoke-with-response-stream` and
  `converse-stream` are re-issued through the gateway's own boto3 client. The
  two streaming operations are decoded and re-encoded into the AWS
  event-stream format, so your boto3 client sees exactly what Bedrock would
  send.

Token usage for a streamed OpenAI call is reported only when the request sets
`stream_options={"include_usage": True}`. The gateway does not add it.

## Errors

- OpenAI and Anthropic upstream HTTP errors pass through with their status
  and body.
- An exception inside the gateway returns `502` with
  `{"error": "gateway_error", "detail": ...}`. An unknown provider prefix
  returns `404`. A Bedrock request with a bad JSON body returns `400`.
- Bedrock `ClientError` bodies are rebuilt as JSON with the upstream status,
  not passed through byte for byte.
- An exception after a stream has started closes the connection; there is no
  status code to send at that point.
