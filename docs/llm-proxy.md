# LLM proxy

Every agent and workflow container runs its own copy of `llm_proxy`. OpenAI,
Anthropic and Bedrock calls from your code go through it, which is how
CanyonOS collects token usage and cost per request without changing the
calling code.

## Where it runs

The local controller inside each container starts the proxy as a subprocess
bound to `127.0.0.1:8081`. The boot log prints `Started LLM proxy on
127.0.0.1:8081 (PID: n)`. There is no proxy on your machine and no shared
proxy between containers. This is the same on EC2.

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
Ollama or OpenRouter from the agent's environment. The proxy reads its
upstream from `OPENAI_UPSTREAM_BASE` and `ANTHROPIC_UPSTREAM_BASE` and
defaults to the real providers. Because the proxy inherits the container
environment, setting one of those in the `env_file` redirects the upstream.

The proxy does not convert providers. Request body, model id and response
parsing pass through as your code wrote them.

## What goes in `.env`

The proxy takes its upstream key from the container environment:
`OPENAI_API_KEY` and `ANTHROPIC_API_KEY`, and the usual AWS credentials for
Bedrock. The `env_file` in the manifest is how those reach the container.

An empty `OPENAI_API_KEY=` line is not the same as no line. The proxy sees an
empty key, forwards the call with no `Authorization` header, and the provider
answers 401. Leave the line out until you have a key.

Your code may still need a placeholder key of its own. The openai and
anthropic SDKs refuse to construct a client without one. The proxy strips the
caller's `Authorization` and `x-api-key` headers and inserts its own key, so
any non-empty value works.

For Bedrock, botocore signs requests even when the endpoint is overridden, so
a caller may need placeholder AWS credentials. The proxy re-issues the call
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

The proxy logs every call it forwards, with the logger name `llm_proxy`, an
arrow, the provider, the method and path, and the model:

```bash
docker logs <container> 2>&1 | grep 'llm_proxy: [→←]'
```

A completed request with no such line went to the provider directly. The
older recipe `grep -E "LLM proxy|8081"` only matches the boot line.

`curl http://127.0.0.1:8081/healthz` from inside the container returns the
registered providers. It says nothing about whether the upstream key is
valid. Bedrock is registered only when the image can import `boto3`, which
the build adds when your code imports it.

## Supported call shapes

- OpenAI and Anthropic non-streaming calls are buffered and forwarded.
- OpenAI and Anthropic streaming calls work. When the upstream answers with
  `text/event-stream`, the proxy relays it chunk by chunk as it arrives, so
  `.stream()`, `.astream()` and a raw `stream=True` all read token by token.
  If the upstream fails mid-stream, the proxy aborts the response instead of
  ending it cleanly, so the caller sees an error rather than a truncated
  answer.
- Bedrock `invoke`, `converse`, `invoke-with-response-stream` and
  `converse-stream` are re-issued through the proxy's own boto3 client. The
  two streaming operations are decoded and re-encoded into the AWS
  event-stream format, so your boto3 client sees exactly what Bedrock would
  send.

Two caveats for streaming:

- Token usage for a streamed OpenAI call is reported only when the request
  sets `stream_options={"include_usage": True}`. The proxy does not add it.
- `canyonos test --stub-llm` answers OpenAI and Anthropic with a plain JSON
  body even for a streaming request, so code that reads tokens as they arrive
  can fail or come back empty under the stub. Plain `canyonos test` calls the
  real model.

## Errors

- OpenAI and Anthropic upstream HTTP errors pass through with their status
  and body.
- An exception inside the proxy returns `502` with
  `{"error": "proxy_error", "detail": ...}`. An unknown provider prefix
  returns `404`. A Bedrock request with a bad JSON body returns `400`.
- Bedrock `ClientError` bodies are rebuilt as JSON with the upstream status,
  not passed through byte for byte.
- An exception after a stream has started closes the connection; there is no
  status code to send at that point.
