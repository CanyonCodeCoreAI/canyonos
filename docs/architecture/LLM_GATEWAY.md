# LLM Gateway

Every agent replica runs an LLM Gateway process next to its Local Controller. The
agent's OpenAI-format, Anthropic and Bedrock calls go through it: it applies the live
prompt version, any model switch from spend rules, and the `llms.yaml` allow-list and
cost cap, then forwards the call and records its tokens on the calling future. What a
user configures is in [LLM Gateway](../guides/LLM_GATEWAY.md); this page is how it is
built.

## Code

All under `packages/core/canyonos_core/llm_gateway/`:

| Module                          | Role                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `__main__.py`, `config.py`      | Entry point, and settings from the environment (`Config.from_env`)                                     |
| `app.py`                        | The Flask app: `GET /healthz` and `/<provider>/<path>`, and the error responses                        |
| `core.py`                       | `proxy_request`, the per-call path below, and `_switch_model`                                          |
| `providers/`                    | One forwarder per provider (`build_registry`): `HttpProvider` in `base.py`, OpenAI, Anthropic, Bedrock |
| `routing.py`                    | The 5-second refresh, `route` (allow-list and cap), `worst_case_cost`, `denied_response`               |
| `llms.py`                       | Loads `llms:config` and indexes it by normalized model ID                                              |
| `pricing.py`, `llm_prices.json` | `LLM_HOSTS`, token prices and call cost                                                                |
| `prompts.py`                    | The live prompt version per `<agent>.<function>`                                                       |
| `hooks.py`                      | Logging, usage extraction, and the telemetry each response writes to Redis                             |
| `proxy.py`                      | The mitmproxy addon on `127.0.0.1:8082` that sends LLM calls to the gateway                            |

Pieces that live elsewhere:

| Path                                                    | Role                                                             |
| ------------------------------------------------------- | ---------------------------------------------------------------- |
| `controller/local_controller.py` (`_start_llm_gateway`) | Starts the gateway, waits for `/healthz`, restarts it            |
| `controller/gateway_headers.py`                         | Adds the future and function headers in the agent's process      |
| `controller/governance.py`                              | `model_for`, the spend rule's model switch                       |
| `reconciler/providers/shared_utils/llm_gateway_env.py`  | The environment that routes the container's calls to the gateway |
| `stub_generator.py` (`GATEWAY_REQUIREMENTS`)            | The gateway's own venv in each agent image                       |
| `controller/utils/otel_writer.py`                       | Prices calls for the dashboard with `pricing.py`                 |

## Where it runs

```text
┌─ agent replica container ────────────────────────────────────────────────────┐
│ ┌──────────────────────────────┐          ┌──────────────────────────────┐   │
│ │ Local Controller (app venv)  │  starts  │ LLM Gateway                  │   │
│ │   gateway_headers.install()  ├─────────►│   /opt/canyonos-gateway venv │   │
│ │   adds the future-id header  │          │   127.0.0.1:8081             │   │
│ │                              │          │   proxy on 127.0.0.1:8082    │   │
│ │ agent code                   │   HTTP   │                              │   │
│ │   OpenAI or Anthropic SDK,   ├─────────►│                              │   │
│ │   boto3 bedrock-runtime      │          │                              │   │
│ └──────────────────────────────┘          └───────┬───────────────┬──────┘   │
└───────────────────────────────────────────────────┼───────────────┼──────────┘
                                                    │               │
                                     tokens, policy │               │ the real call
                                                    ▼               ▼
                                              machine Redis      model providers
                                              future:<id>, llms:config
```

- The Local Controller of an agent replica starts the gateway before it loads the agent
  (`_start_llm_gateway`), with `GATEWAY_HOST=127.0.0.1`, `GATEWAY_PORT=8081`, the
  replica's Redis, and `HTTP_PROXY` and `HTTPS_PROXY` removed so the gateway's own calls
  don't loop back. It checks that `8081` and `8082` are free and waits up to 60 seconds
  for `/healthz`. The endpoint's Local Controller starts no gateway.
- The gateway has its own venv, `/opt/canyonos-gateway`, with pinned Flask, requests,
  redis and mitmproxy, plus boto3 when the agent's image has it
  (`GATEWAY_REQUIREMENTS` in `stub_generator.py`). The agent's own environment gets no
  extra CanyonOS dependencies. Outside an image, it runs on the Local Controller's
  Python.
- Every call it supports goes through it, with no fallback to a direct call. If the
  gateway exits, the Local Controller restarts it, and after 3 restarts fails the
  replica, which is then replaced.
- Providers, keyed by the path's first part: `openai` (any OpenAI-format API on a host
  in `LLM_HOSTS`, Baseten among them), `anthropic`, and `bedrock`, registered only when
  boto3 is installed.

### How calls reach it

Whatever launches the replica sets these in the container (`llm_gateway_env.py` on
Docker and EC2, `agent.go` in the operator). On Docker they are `docker run -e` flags,
which win over the project's `.env`.

| Variable                                               | Value                                            | Effect                                                                                                  |
| ------------------------------------------------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `AWS_ENDPOINT_URL_BEDROCK_RUNTIME`                     | `http://127.0.0.1:8081/bedrock`                  | boto3 sends Bedrock calls to the gateway                                                                |
| `HTTP_PROXY`, `HTTPS_PROXY`                            | `http://127.0.0.1:8082`                          | every other HTTP(S) call leaves through the proxy; uppercase only, so gRPC between controllers skips it |
| `NO_PROXY`                                             | localhost and the EC2 and ECS metadata addresses | boto3 still reaches its credentials directly                                                            |
| `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, `AWS_CA_BUNDLE` | `/tmp/canyonos-proxy/ca-bundle.pem`              | clients trust the certificates the proxy presents                                                       |

The proxy (`proxy.LlmCalls`, mitmproxy in a thread of the gateway's process) writes
that bundle, the system roots plus its own CA, once it listens. It decrypts only
connections to a host in `LLM_HOSTS`; any other HTTPS connection passes through still
encrypted, so its client keeps its own TLS. A `POST` to an OpenAI-format or Anthropic
LLM path whose JSON body has a string `model` goes to the gateway; anything else goes to
its host unchanged. Calls that miss all of this reach the provider directly; the user
guide lists them in
[Code that bypasses the gateway](../guides/LLM_GATEWAY.md#code-that-bypasses-the-gateway).

## Request path

```text
agent SDK call
 ├─ any HTTP(S) call, through HTTPS_PROXY ─► proxy.LlmCalls (mitmproxy, 127.0.0.1:8082)
 │   ├─ HTTPS to a host outside LLM_HOSTS: passed through, still encrypted
 │   ├─ POST to an OpenAI-format or Anthropic path with a "model" in its JSON body:
 │   │   sent to 127.0.0.1:8081/<provider>/<same path>, with x-canyonos-upstream
 │   └─ anything else: passed through to its host
 └─ base-URL env var (/bedrock/...) ─► 127.0.0.1:8081/bedrock/...

POST 127.0.0.1:8081/<provider>/<subpath>
 └─ app.dispatch                                    unknown provider ─► 404
     └─ core.proxy_request
         ├─ _switch_model: the model governance switched this agent to, if any
         ├─ prompts.apply: the live system prompt for <agent>.<function>, if any
         ├─ hooks.on_request: log the call
         ├─ routing.route(model_id, body, price_prefix)    denied ─► 403 denied_response
         └─ provider.forward ─► GatewayResponse
             ├─ content: hooks.on_response, then the response to the agent
             ├─ stream: relay chunks to the agent, hooks.on_response when it ends
             ├─ provider timeout ─► 504 gateway_error
             └─ connection error or any other exception ─► 502 gateway_error
```

The `x-canyonos-upstream` header carries the original `<scheme>://<host>:<port>`. The
OpenAI-format paths the proxy recognizes are `/chat/completions`, `/completions`,
`/embeddings`, `/responses` and `/responses/input_tokens`; the Anthropic ones are
`/messages` and `/messages/count_tokens`. A connection error answers
`"Could not reach <host>"`.

A refused call gets a `403` that the OpenAI, Anthropic and boto3 clients all surface
with the reason: `{"message", "error": {"type": "llm_policy_blocked", "message"}}` and
`x-amzn-ErrorType: AccessDeniedException`. A gateway error carries the reason in both
`error.message` and a top-level `message`, which is the only place boto3 reads it. The
connect timeout is 10 seconds and the read timeout 600.

## Providers and streaming

- OpenAI and Anthropic share `HttpProvider`. The URL is `x-canyonos-upstream` plus the
  path and query, and the agent's own headers, its `Authorization` or `x-api-key`
  among them, are kept.
- A streamed OpenAI `completions` call (chat or legacy) gets
  `stream_options.include_usage` added unless the caller set it or the host is
  `api.mistral.ai`, and the gateway drops that usage-only chunk when relaying.
- Bedrock parses `model/<id>/<op>` from the path and calls boto3 `bedrock-runtime` on
  `BEDROCK_UPSTREAM_HOST`: `invoke`, `converse`, `converse-stream` or
  `invoke-with-response-stream`; any other op fails with a message naming those four.
  A boto3 error comes back as JSON with Bedrock's status and message.
- A `text/event-stream` response is relayed chunk by chunk, unchanged. On the way, the
  gateway reads the `data:` lines and merges the usage they carry. An upstream failure
  mid-stream aborts the response rather than ending it cleanly, so a partial answer
  can't pass for a complete one.
- A Bedrock stream is decoded by boto3 and re-encoded as event-stream frames for the
  agent's boto3. Usage comes from the `metadata` event, and a failure mid-stream is
  sent as an exception frame.
- For both, usage and any stream error are recorded when the stream ends. A caller that
  disconnects early records no usage, since a partial count would read as a finished,
  cheaper call.

## Telemetry

At startup the Local Controller installs `gateway_headers`. It patches httpx sends (both
`httpx` and `httpx2`) and boto3's Bedrock signing, so every `POST` to an LLM path, and
every Bedrock call, carries `x-canyonos-future-id`, the future the calling thread runs,
and `x-canyonos-function`, the agent function it runs (`set_current_function`). The
request context follows the agent into threads and pools it starts
(`canyonos_context.install`).

On each response, `hooks.on_response` extracts the usage per provider and operation and
adds it to `future:<future_id>` in the machine Redis, so the counts sum over the
future's calls:

| Field                                                       | Write     |
| ----------------------------------------------------------- | --------- |
| `model`, `price_prefix`                                     | `HSET`    |
| `prompt_name`, `prompt_version`, when a prompt was applied  | `HSET`    |
| `errors` (1 for a status of 400 or more, or a stream error) | `HINCRBY` |
| `input_token_count`, `output_token_count`, `token_count`    | `HINCRBY` |
| `input_cache_tokens`, `input_cache_write_tokens`            | `HINCRBY` |

Input counts include cache reads and writes. Bedrock `invoke` usage is parsed only for
`anthropic.*` models, whose body is Anthropic's own. A `200` with no usage logs a
warning, and a call without `x-canyonos-future-id` is not recorded. Each Global
Controller poll (`otel_writer.send_telemetry`) scans `future:*` and queues the rows for
the dashboard.

## Policy and prices

The Global Controller publishes `config/llms.yaml` to `llms:config` in every machine
Redis, after checking that every capped entry has a numeric `max_tokens` and numeric
caps; a bad file fails the deploy. Every 5 seconds `routing.refresh` reloads
`llms:config`, `prompts:config` and the governance rules, keeping the last good copy of
each when a load fails.

`routing.route` decides each call:

1. Before `llms:config` has loaded once, every call is refused.
2. The model ID is normalized (a Bedrock ARN or a cross-region prefix such as `us.` is
   stripped). A model with no `llms.yaml` entry, or an entry with no `agents`, is
   allowed.
3. An agent not listed under the entry's `agents` is refused. A listed agent with no
   cap is allowed.
4. A capped call is refused when the model has no price at the provider serving it,
   when its body isn't a JSON object, or when `worst_case_cost` is over the cap. That
   cost takes the body's size / 4 as input tokens, and the requested `max_tokens`
   (OpenAI, Anthropic or Converse spelling), else the entry's, times `n` as output
   tokens.

Prices come from `llm_prices.json` plus LiteLLM's current prices. The Global Controller
fetches those at startup (`litellm_prices`), adds them to its own copy and publishes
them to `llm_prices:models`, which the gateway loads once when it starts. A call's
`price_prefix` is LiteLLM's prefix for the host it went to (`LLM_HOSTS`, such as
`together_ai`), tried before the plain model ID. `otel_writer` prices calls for the
dashboard from the Global Controller's copy.

### Switching model on spend

`routing.refresh` also loads the governance rules (`controller/governance.py`, imported
flat as `canyonos_governance` inside images) into `routing.rules`. At the top of
`proxy_request`, `governance.model_for(rules, AGENT_NAME)` names the model this agent's
highest tripped spend rule switches to, and `_switch_model` writes it into the call: the
`model/<id>/<op>` subpath on Bedrock, the body's `model` field elsewhere. A body without
a `model` (a file upload, a model listing) is left alone. So `route()` checks the
switched model against `llms.yaml`, and telemetry records it.

The upstream host never changes, so a switch stays within one provider. On Bedrock,
`converse*` takes any model, and `invoke*` only one of the same family, whose body
format it shares. The gateway evaluates the rules itself rather than trusting an
`x-canyonos-*` header, which the agent's own process sets. `deny` rules are applied by
the Local Controller, at dispatch.

## Prompts

Prompts reach the gateway through Redis:

1. On start or reload, the Global Controller stores `config/prompts.yaml` in its Redis
   as `prompts:yaml`. It writes the live versions to `prompts:config` only if that key
   is empty.
2. When the dashboard API starts, it inserts into Postgres (`system_prompts`) every
   prompt that has no rows yet, keeping the YAML's live flags; a prompt added to the
   YAML later is stored on the next listing. Saving a version or making one live on the
   dashboard writes Postgres. At startup and after every write, the API sets
   `prompts:config` to each prompt's live version.
3. Every poll, the Global Controller copies `prompts:config` to each machine Redis.
4. Every 5 seconds, the gateway reloads it and keeps the live version per
   `<agent>.<function>` in memory.

The Local Controller sets the current function (`set_current_function`) before running
it, so `gateway_headers` adds `x-canyonos-function` to the call. `proxy_request` looks
up `<agent>.<function>` (`prompts.apply`), and the provider's `set_system` puts the live
text where that call takes its system prompt:

| Provider and call                | Where the prompt goes                                                                           |
| -------------------------------- | ----------------------------------------------------------------------------------------------- |
| OpenAI `chat/completions`        | a leading `system` message, replacing any `system` or `developer` messages                      |
| OpenAI `responses`               | `instructions`                                                                                  |
| Anthropic `messages`             | `system`                                                                                        |
| Bedrock `converse*`, Amazon Nova | `system: [{"text": ...}]`                                                                       |
| Bedrock `invoke*`                | by model family: `system`, `preamble`, a system message, or prefixed to `prompt` or `inputText` |

Any other call, or a body that isn't a JSON object, is sent unchanged.
`hooks.on_response` records `prompt_name` and `prompt_version` on `future:<id>`.

A redeploy with the same `project_id` sets `prompts:yaml` again and leaves
`prompts:config` alone. The rules a user sees are in
[Prompt management](../guides/PROMPTS.md).

## Configuration

What the gateway reads from its environment:

| Variable                                                       | Default                                  | Meaning                                          |
| -------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------ |
| `GATEWAY_HOST`, `GATEWAY_PORT`                                 | `127.0.0.1`, `8080`; `8081` in a replica | where it listens                                 |
| `GATEWAY_CONNECT_TIMEOUT`, `GATEWAY_READ_TIMEOUT`              | `10`, `600` seconds                      | timeouts for OpenAI-format and Anthropic calls   |
| `BEDROCK_REGION`, else `AWS_REGION`, else `AWS_DEFAULT_REGION` | `us-east-1`                              | the Bedrock region                               |
| `BEDROCK_UPSTREAM_HOST`                                        | `bedrock-runtime.<region>.amazonaws.com` | where Bedrock calls go                           |
| `CANYONOS_REDIS_HOST`, `CANYONOS_REDIS_PORT`                   | `localhost`, `6379`                      | the machine Redis, for config and telemetry      |
| `CANYONOS_REDIS_PASSWORD`, `_USERNAME`, `_TLS`, `_CA_FILE`     | unset                                    | Redis auth and TLS, as for every CanyonOS client |
| `CANYONOS_AGENT_NAME`                                          | unset                                    | the agent whose rules and prompts apply          |

## Changing the gateway

- The end-to-end projects with model calls, and the governance scenario, exercise the
  gateway; see [Development](../contributing/DEVELOPMENT.md#tests).
- The gateway runs in its own venv, so a new dependency goes into
  `GATEWAY_REQUIREMENTS`, not the agent's requirements.
- A new provider needs an entry in `build_registry`, its LLM paths in
  `hooks.LLM_PATHS` (for the proxy and `gateway_headers`), its hosts in `LLM_HOSTS`, and
  a usage parser in `Hooks._extract_usage`.
- `llm_gateway/README.md`, beside the code, covers running the gateway on its own.
