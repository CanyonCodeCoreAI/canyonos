# LLM Gateway

Every model call an agent makes goes through the LLM Gateway inside the agent's
container. With no setup, every agent can call every model, and the gateway records each
call's tokens and cost on its request for the [dashboard](DASHBOARD.md). How the gateway
is built is in [LLM Gateway architecture](../architecture/LLM_GATEWAY.md).

On each call, the gateway also applies these settings:

| Set in                | What the gateway does                                                        | See                                                   |
| --------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------- |
| `llms.yaml`           | Refuses the call when the file doesn't allow it                              | [What gets refused](#what-gets-refused)               |
| `prompts.yaml`        | Puts in the live system prompt, when the file has one for the agent function | [Prompt management](PROMPTS.md)                       |
| A `switch_model` rule | Sends the call to another model once the agent's spend passes the rule       | [Switching model on spend](#switching-model-on-spend) |

## Define the limits in a file

Create `llms.yaml` in the workflow's `config` folder. Each entry names a model and the
agents allowed to use it:

```yaml
haiku:
  model_id: us.anthropic.claude-haiku-4-5-20251001-v1:0
  max_tokens: 1024
  agents:
    IntentAgent: 0.01
    AdvisorAgent:
```

| Key          | Required                | What it does                                                                                                                                                                                                                             |
| ------------ | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| entry name   | yes                     | Your own label for the model, such as `haiku`. It shows in refusal messages.                                                                                                                                                             |
| `model_id`   | yes                     | The model ID your code sends to the provider. An entry without one is ignored.                                                                                                                                                           |
| `max_tokens` | when an agent is capped | The output tokens to assume when a call doesn't set its own limit                                                                                                                                                                        |
| `agents`     | no                      | The agents allowed to call this model, each with the most one call may cost, in US dollars. An empty value, like `AdvisorAgent` above, means no cap. Leave `agents` out to let every agent call the model; an empty `agents:` lets none. |

`model_id` is matched without a Bedrock region prefix (`us.`, `eu.`, `apac.` and the
like) or an ARN around it, so `us.anthropic.claude-haiku-4-5-20251001-v1:0` also matches
calls to `anthropic.claude-haiku-4-5-20251001-v1:0`.

`canyonos deploy` fails when `llms.yaml` isn't valid YAML, when `agents` isn't a
mapping, or when an entry with a cap has no numeric `max_tokens` or a cap that isn't a
number. A typo in a `model_id` is not caught: real calls don't match the entry, so they
run with no cap.

### What gets refused

For each call, the gateway looks up the model by its `model_id`:

| Case                                                                                      | Result  |
| ----------------------------------------------------------------------------------------- | ------- |
| The model isn't in `llms.yaml`, or its entry has no `agents`                              | Allowed |
| The agent isn't in the model's `agents`                                                   | Refused |
| The agent has no cap on the model                                                         | Allowed |
| The call could cost more than the agent's cap                                             | Refused |
| The agent has a cap, and there is no price for the model at the provider serving the call | Refused |
| The agent has a cap, and the request body isn't a JSON object                             | Refused |

A refused call never reaches the provider. The agent gets a `403` with the reason, which
the OpenAI, Anthropic and AWS clients all show as an error. Until the gateway has read
`llms.yaml` once after it starts, it refuses every call.

### How cost is checked

The gateway checks a call's cost before sending it, so it uses the most the call could
cost. A call is refused when that cost is over the cap, even if the real answer would
have been shorter.

| Part   | Tokens counted                                                                                                                                                                                                                                                 |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input  | The size of the request, at 4 bytes per token                                                                                                                                                                                                                  |
| Output | The output-token limit the call sets (`max_tokens`, `max_completion_tokens`, `max_output_tokens`, or Bedrock Converse's `inferenceConfig.maxTokens`), or the entry's `max_tokens` if it sets none. A call that asks for several answers (`n`) counts each one. |

## Change the limits while the workflow runs

Edit `llms.yaml` and run `canyonos sync`. Each gateway picks up the changed file within
5 seconds.

## Model prices

Prices come from CanyonOS's own price list, used both to check caps and to report spend
on the dashboard. A model with no price shows as costing $0 on the dashboard, and a
capped call to it is refused.

When the Global Controller starts, it downloads LiteLLM's current prices once and adds
them to its copy of the list; where both list a model, LiteLLM's price wins. It
publishes them to each machine's Redis before any replica starts, and each gateway adds
them to its copy when it starts. If the download fails, everything uses CanyonOS's list
alone.

Hosted models that several providers serve, such as Llama or GLM, have a different price
at each provider. A call to a known provider host uses that provider's price; a call to
any other host uses the model's plain price. The known hosts are OpenAI, Anthropic,
OpenRouter, Azure OpenAI (any `*.openai.azure.com`), Together, Fireworks, Baseten, xAI,
Moonshot, DeepInfra, Groq, Mistral, Cerebras, DeepSeek, Gemini, Vercel AI Gateway,
Perplexity, SambaNova, Hyperbolic, Z.ai and Lambda. The current list is `LLM_HOSTS` in
[`pricing.py`](https://github.com/CanyonCodeCoreAI/canyonos/blob/main/packages/core/canyonos_core/llm_gateway/pricing.py).

## Switching model on spend

When an agent's spend passes a `switch_model` rule (see
[Policy](RUNTIME_CONTRACT.md#policy)), the gateway sends each of that agent's calls to
the rule's model instead, within a few seconds. A `deny` rule is not applied here: the
Local Controller refuses those calls before they run.

The gateway rewrites the model the call names and nothing else, so:

- The new model must be served by the same provider: the call still goes to the same
  host with the same keys.
- On Bedrock, `converse` and `converse-stream` work with any model, while `invoke` and
  `invoke-with-response-stream` only switch within a model family, because each family
  has its own request body.

The switched call is then checked against `llms.yaml` like any other, so the new model
must be allowed for the agent.

## Which calls go through it

The gateway runs in every replica, on `127.0.0.1:8081`, with a proxy on
`127.0.0.1:8082`, the same on Docker, EC2 and Kubernetes. There is no gateway on your
machine and none shared between containers. On the host, `8081` is the local dashboard
by default, so pointing an SDK at `host.docker.internal:8081` reaches the dashboard, not
a gateway.

**OpenAI-format and Anthropic calls** need no setup. CanyonOS sets `HTTP_PROXY` and
`HTTPS_PROXY` on every container, so every HTTP(S) call, from any process, leaves
through the gateway's proxy. The proxy hands the gateway any `POST` whose JSON body
names a `model` and whose path ends in `/chat/completions`, `/completions`,
`/embeddings`, `/responses`, `/responses/input_tokens`, `/messages` or
`/messages/count_tokens`, whatever host and base URL your code set. Every other call
passes through untouched.

That covers OpenAI, Azure OpenAI, Gemini, Groq, Together, Fireworks, OpenRouter,
Baseten, vLLM, Ollama, any other OpenAI-compatible API and Anthropic, through any client
that reads the proxy variables. Plain HTTP is always read. HTTPS is read only to the
known hosts listed under [Model prices](#model-prices); to any other host it passes
through still encrypted.

For those known hosts, the proxy answers with its own certificates, signed by a
certificate authority it creates when the container starts. `SSL_CERT_FILE`,
`REQUESTS_CA_BUNDLE` and `AWS_CA_BUNDLE` point clients at a file that trusts it.

**Bedrock calls** reach the gateway through `AWS_ENDPOINT_URL_BEDROCK_RUNTIME`, which
CanyonOS sets to `http://127.0.0.1:8081/bedrock` on every container. boto3 reads it, and
a value in your `.env` can't override it. The gateway supports `invoke`, `converse`,
`invoke-with-response-stream` and `converse-stream`. Bedrock is available only in an
image that can import `boto3`: the entry's `requirements` must install it, directly or
as a dependency.

The gateway does not convert between providers: the request body, model ID and response
parsing stay as your code wrote them. Streamed responses are relayed chunk by chunk as
they arrive.

## What goes in `.env`

| Calls                       | Credentials                                                                                                                                                                                                                                                                                                       |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI-format and Anthropic | Your code's own key. The gateway passes `Authorization` and `x-api-key` through unchanged, so put the provider's key (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `BASETEN_API_KEY`, ...) wherever your code reads it from.                                                                                            |
| Bedrock                     | The gateway's: it uses the usual AWS credentials from the container environment, which reach the container through the workflow's `.env`. `botocore` signs requests even when the endpoint is overridden, so a caller may need placeholder AWS credentials; the gateway re-issues the call upstream with its own. |

## Code that bypasses the gateway

A client that ignores the proxy variables, such as an `aiohttp.ClientSession` without
`trust_env=True`, goes straight to the provider. Grep for `aiohttp` in the source to
find those. In the code under the workflow root, the fix for aiohttp is to let it read
them:

```python
aiohttp.ClientSession(trust_env=True)
```

A client that pins certificates, sends a client certificate (mTLS) or uses its own CA
bundle for an LLM host fails instead, since the proxy answers with its own certificate.

## Confirm the route

A replica's boot log prints `Started LLM gateway on 127.0.0.1:8081 (PID: n)`. The
gateway then logs every call it forwards, with the logger name `llm_gateway`, an arrow,
the provider, the method and path, and the model:

```bash
docker logs <container> 2>&1 | grep 'llm_gateway: [→←]'
```

A completed request with no such line went to the provider directly.

`curl http://127.0.0.1:8081/healthz` from inside the container returns the registered
providers. It says nothing about whether the upstream key is valid.

## Errors your code may see

| What happened                                                          | What your code gets                                                                 |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `llms.yaml` refused the call                                           | `403` with the reason                                                               |
| The provider answered with an error                                    | Its status and body, unchanged. A Bedrock error is rebuilt as JSON with its status. |
| The provider didn't connect within 10 seconds, or sent nothing for 600 | `504`, with `"type": "gateway_error"`                                               |
| The provider couldn't be reached, or the gateway failed                | `502`, with `"type": "gateway_error"`                                               |
| A Bedrock request body that isn't valid JSON                           | `400`                                                                               |
| The provider failed in the middle of a stream                          | The connection is closed, so your client sees an error, not a truncated answer      |
| A background-mode Responses call (`GET .../responses/{id}`)            | The provider's answer, but no tokens are recorded                                   |

## Network limits

Every HTTP(S) call from an agent container, except to `127.0.0.1`, `localhost` and the
cloud metadata addresses, goes through the gateway's proxy on `127.0.0.1:8082`. That
means:

- Company proxies aren't supported. CanyonOS sets `HTTPS_PROXY` itself, so a proxy in
  your `.env` is ignored and calls go out directly. On a network that only allows
  traffic through a company proxy, every call fails.
- Clients that skip the proxy or pin certificates aren't recorded or fail; see
  [Code that bypasses the gateway](#code-that-bypasses-the-gateway).
- HTTPS LLM calls to a host the proxy doesn't know, such as a self-hosted vLLM behind
  HTTPS, aren't caught. Plain-HTTP servers are.
- The app can't listen on ports `8081` and `8082`: the gateway and its proxy use them.
- A stopped gateway makes all outbound calls fail, not just LLM calls.
- Large downloads go through the same proxy as LLM calls, so they can slow each other
  down.
- Some OpenAI-compatible APIs reject streamed calls. The gateway adds `stream_options`
  to every streamed completion to read token usage (except to Mistral, which sends it
  anyway), and strict APIs refuse it, for example Azure OpenAI before api-version
  `2024-09-01-preview`. When your call didn't ask for usage, the gateway removes the
  usage chunk, so your code sees the stream it would without the gateway.
- Building an agent image needs network access, to download Python 3.12 and mitmproxy
  for the gateway.
