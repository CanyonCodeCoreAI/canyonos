# llm_gateway

Contract reference: [docs/guides/LLM_GATEWAY.md](../../../../docs/guides/LLM_GATEWAY.md).

A local, single-machine pass-through gateway for **OpenAI-format** calls to any
provider, **Anthropic**, and **Bedrock**. Callers keep their exact SDK calling
convention. Every call flows through one function (`core.proxy_request`) where
token/metrics hooks fire.

**Scope:** request/response and streaming, for all three.

## How it works

```
your app (unchanged)                                     localhost:8080 (standalone)       real upstream
  openai SDK    ─/openai/.../chat/completions ───────┐
  anthropic SDK ─/anthropic/.../messages ────────────┼─▶ proxy_request(ctx) ─▶ provider ─▶ x-canyonos-upstream host
  boto3 bedrock ─/bedrock/... ───────────────────────┘    (metrics hooks)      adapter     bedrock-runtime.<region>.amazonaws.com
```

- **OpenAI-format** — straight HTTP reverse-proxy to the host in the
  `x-canyonos-upstream` header, path and the caller's own key unchanged.
- **Anthropic** — the same, to the host in the `x-canyonos-upstream` header.
- Both forward with `requests` and return the response. Server-sent-event
  responses are relayed byte-for-byte while usage is folded out of the events. An
  upstream failure mid-stream aborts the response rather than ending it cleanly,
  so a partial answer can't reach the caller looking like a complete one.
- **Bedrock** — re-issued through the gateway's own `boto3` client (handles SigV4
  signing + URL-encoding correctly). `invoke`, `converse`, `converse-stream`,
  and `invoke-with-response-stream` are all wired up.

## Run

```bash
pip install -r llm_gateway/requirements.txt

export AWS_REGION=us-east-1          # + normal AWS creds (env / ~/.aws / role)

python -m canyonos_core.llm_gateway    # standalone default: 127.0.0.1:8080
```

The module also starts its proxy on `127.0.0.1:8082`. Inside an agent container, the
Local Controller runs it on `127.0.0.1:8081`, injects the Bedrock environment
variables, and points `HTTPS_PROXY` at the proxy, which sends every OpenAI-format and
Anthropic call there automatically.

## Point your SDKs at it

For a standalone gateway, Bedrock needs only an env var:

```bash
export AWS_ENDPOINT_URL_BEDROCK_RUNTIME=http://localhost:8080/bedrock
```

An OpenAI-format or Anthropic client outside a container names the real host itself:

```python
from openai import OpenAI
OpenAI(base_url="http://localhost:8080/openai/v1",
       default_headers={"x-canyonos-upstream": "https://api.openai.com"},
       ).chat.completions.create(model="gpt-4o-mini",
                                 messages=[{"role": "user", "content": "hi"}])

from anthropic import Anthropic
Anthropic(base_url="http://localhost:8080/anthropic",
          default_headers={"x-canyonos-upstream": "https://api.anthropic.com"},
          ).messages.create(model="claude-3-5-sonnet-20241022", max_tokens=64,
                            messages=[{"role": "user", "content": "hi"}])

import boto3, json
boto3.client("bedrock-runtime").invoke_model(
    modelId="anthropic.claude-3-5-sonnet-20240620-v1:0",
    body=json.dumps({"anthropic_version": "bedrock-2023-05-31",
                     "max_tokens": 64,
                     "messages": [{"role": "user", "content": "hi"}]}))
```

## Configuration (env vars)

| Var | Default | Purpose |
|---|---|---|
| `GATEWAY_HOST` / `GATEWAY_PORT` | `127.0.0.1` / `8080` | where the gateway listens |
| `GATEWAY_CONNECT_TIMEOUT` / `GATEWAY_READ_TIMEOUT` | `10` / `600` | upstream timeouts (s) |
| `BEDROCK_REGION` (or `AWS_REGION`) | `us-east-1` | Bedrock region |
| `BEDROCK_UPSTREAM_HOST` | `bedrock-runtime.<region>.amazonaws.com` | override Bedrock host |

## Telemetry & Metrics

The gateway captures, per response:
- Model ID
- Input/output/total token counts
- Cache tokens (read & write, where the provider reports them)
- Error status

Telemetry is written to Redis under `future:<future_id>` keys, keyed off an
`X-Canyonos-Future-ID` request header.

### Usage extraction coverage (`hooks.py::Hooks._extract_usage`)

| Provider / op | Usage schema used | Status |
| --- | --- | --- |
| Bedrock `converse` / `converse-stream` | Bedrock's own camelCase (`inputTokens`, ...) | works for any model |
| Bedrock `invoke` / `invoke-with-response-stream`, `anthropic.*` model | Anthropic's native (`input_tokens`, ...) | works |
| Bedrock `invoke` / `invoke-with-response-stream`, other model families | model-specific, unknown | no usage (schema not implemented yet) |
| Direct Anthropic API (`.../messages`) | Anthropic's native | works, streaming and non-streaming |
| OpenAI-format (`.../chat/completions`, `.../completions`, `.../embeddings`, `.../responses`) | OpenAI's native (`prompt_tokens`, ...) | works, streaming and non-streaming; `GET .../responses/{id}` is not recorded |

### How it works

1. **Auto-injection:** `controller/gateway_headers.py` (installed by the Local Controller) injects the `X-Canyonos-Future-ID` header from thread-local context for all three providers -- a boto3 event hook for Bedrock, and an `httpx.Client.send` patch that tags OpenAI-format and Anthropic calls, which the container's proxy sends to the gateway.
2. **Usage extraction:** `hooks.py`'s `_extract_usage` parses the response `usage` field with the schema matching that provider/op/model (table above) -- this part works for all three providers whenever the header is present.
3. **Redis write:** All metrics written to `future:<future_id>` hash.

## Limitations

- **Bedrock `invoke-with-response-stream` has no usage/token telemetry**
  regardless of model: unlike `converse-stream`, it has no metadata event to
  read usage from (see the usage extraction coverage table above).
- **Bedrock error bodies are reconstructed**, not passed through byte-for-byte
  (boto3 raises on 4xx/5xx; we rebuild a JSON body with the real status +
  message). OpenAI/Anthropic errors pass through unchanged.
- **Dev server.** Runs on Flask's built-in server — fine for a local gateway, not
  meant for production traffic.
