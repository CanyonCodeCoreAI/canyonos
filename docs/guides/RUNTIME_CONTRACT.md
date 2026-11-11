# Runtime contract

The rules CanyonOS applies to your code once it runs: how it loads each agent, how
agents call each other, what the endpoint accepts and answers, and which calls policy
refuses. Read it when you write agent code by hand, or when a deploy comes up but
behaves differently from your app.

## Discovery

`canyonos deploy` reads everything from the [workflow root](BUILD_ARTIFACT.md):

| Input            | Where it comes from                                                   |
| ---------------- | --------------------------------------------------------------------- |
| Workflow config  | `config/workflow_config.yaml`                                         |
| Agent class      | `entrypoint` on an agent entry, relative to the workflow root         |
| Agent functions  | `functions` on an agent entry                                         |
| Endpoint         | The `endpoint:` block, naming the agent method served over HTTP       |
| Policy           | `config/policy.yaml`                                                  |
| Governance rules | `config/governance.yaml`                                              |
| Generated files  | `stubs/`, `grpc_stubs/` and `docker_container/`, written by the build |

An agent entry's `name` must equal the name of a module-level class in its
`entrypoint` file. `canyonos deploy` runs the [`canyonos validate`
checks](IMAGES_AND_DEPENDENCIES.md#what-canyonos-validate-checks) first, so a missing
entrypoint, a schema error or a class it can't find stops the deploy before anything
is built.

## Agent class

In effect, the agent's container does this at start and on each call:

```python
module = load(entrypoint)
agent = getattr(module, configured_name)()
result = getattr(agent, method_name)(**args)
```

| Rule              | What it means for your code                                                                                                                                                                                                                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Construction      | The class takes no constructor arguments (`CANYON-ADAPTER-INIT`)                                                                                                                                                                                                                                         |
| Arguments         | Keyword arguments named as in `functions`, sent as JSON, so an `int` stays an `int`. An argument's declared `type` converts nothing. A `Future` argument, alone or inside a `dict`, `list` or `tuple`, arrives as its result: the type the called function declares under `returns`, or text without one |
| Synchronous calls | Methods are called synchronously. An `async def` is not awaited, and its coroutine's `repr` becomes the result (`CANYON-ADAPTER-ASYNC`)                                                                                                                                                                  |
| Concurrency       | Calls run on a pool of 16 threads against one instance (`CANYONOS_MAX_AGENT_INSTANCES`), and wait in line when all are busy. Keep state on `self` safe for that, or use `replicas: 1` and `stateful: true`                                                                                               |
| Results           | A `dict` or `list` result is JSON-encoded. Anything else becomes `str(result)`                                                                                                                                                                                                                           |
| Module loading    | The entrypoint is loaded from `/app/<basename>.py` as a top-level module, so its module-level code runs at container start, before any request                                                                                                                                                           |
| Relative imports  | A relative import in the entrypoint fails with `attempted relative import with no known parent package`. Modules it imports absolutely keep theirs                                                                                                                                                       |
| File names        | A segment that isn't a Python identifier, such as `06_agent.py`, loads, but a caller's `from steps.06_agent import X` is a `SyntaxError`                                                                                                                                                                 |

Readiness is published only after the agent has loaded. If the import or the
constructor raises, the replica reports `failed`, stops serving and exits.
`canyonos deploy` then prints the last lines of the container's log between
`--- begin container log` and `--- end container log`, and fails.

## Agent functions and stubs

Agents call each other through stubs. Each agent entry produces one Python stub: a
class with the entry's name and one method per entry in its `functions`. A stub method
takes the declared arguments, with no defaults, and returns a `Future` right away, which
your code uses as the result; see [Results of agent calls](#results-of-agent-calls).
The stub imports nothing from your code, so argument and return types are limited to
builtins; see [Agent functions](WORKFLOW_CONFIG.md#agent-functions).

Every image gets every agent's stub at two paths: the agent's `entrypoint` path, and the
image root under that path's basename. The agent's own image then copies the real
module to the root. For `entrypoint: pkg/agent.py`:

| Image             | `/app/pkg/agent.py` | `/app/agent.py` |
| ----------------- | ------------------- | --------------- |
| Any other agent's | stub                | stub            |
| The agent's own   | stub                | real module     |

The agent's container loads `/app/agent.py`; anything else in its image that imports
`pkg.agent` gets the stub. An entrypoint at the workflow root has only one copy, and
the real module wins there.

The stub replaces one module. Everything around it is real:

| Situation                                                           | Result                                                                                              |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| The package `__init__.py` re-exports a name from the stubbed module | Every other agent's image raises `ImportError` at start (`CANYON-PACKAGE-REEXPORT`)                 |
| A sibling module imports a package                                  | Only this entry's `requirements` are installed; add the package to the entry that ships the sibling |
| Code uses a constant, helper or other class from the stubbed module | It doesn't exist in other agents' images: the stub defines only the declared class                  |
| Two agents share an entrypoint                                      | The second stub overwrites the first. Nothing checks this up front                                  |
| Two entrypoints in different folders share a basename               | They collide at the image root the same way. Nothing checks this up front                           |

The stubs and `ask_human` are the only parts of CanyonOS your code imports. The
`canyonos_core` package in an image holds only the LLM Gateway, so importing anything
else from it raises `ImportError` at start.

### Results of agent calls

Agent code uses another agent's result as if the call had returned it. CanyonOS waits
for the result only at the line that first needs it:

```python
draft = Writer().run(query=query)       # sent, nothing waits
stats = Counter().count(text=draft)     # passed on: Counter's replica waits for it
if stats["words"] > 100:                # waits here, and stats is a dict
    draft = Writer().run(query=f"Shorten: {draft}")
return {"draft": draft, "stats": stats} # passed on: the endpoint waits for it
```

The Local Controller rewrites the workflow's modules that call an agent as it loads
them: those that import an agent's class, directly or through another of the
workflow's modules. Every other module, such as a helper module or an agent that calls
no other, loads as written and runs at full speed. So do the standard library,
installed packages and the stubs. In the rewritten code:

| Code                                                                                                                        | What it gets                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A line that uses the value: an operator, a comparison, `if`, `for`, an index, a method or attribute, an f-string, unpacking | The result, as the type the function declares under `returns`, or the stored text without one                                                                           |
| `await a`                                                                                                                   | The result, without blocking the event loop. `asyncio.gather` and `asyncio.wait_for` take a `Future` like any awaitable                                                 |
| A line that only passes the value on: assigning it, putting it in a list or dict, returning it                              | The `Future`, so nothing waits                                                                                                                                          |
| A call to another agent, or to a function, method or class of a rewritten module                                            | The `Future`                                                                                                                                                            |
| Any other call: a library, `print`, `json.dumps`, a module loaded as written                                                | The results, also inside dicts, lists, tuples, sets and generators, and in the attributes of the workflow's own objects                                                 |
| `.value()`                                                                                                                  | Waits and returns the stored text, so code written that way keeps working. `.value`, `.resolved` and `.is_available` are always read on the `Future`, not on its result |

A call that fails raises at the line that uses its result. Calls run at the same time
until something uses their results, so a list built in a comprehension or with
`.append` sends every call before the first wait:

```python
results = [agent.work(item=item) for item in items]   # all sent at once
done = [r for r in results if r["ok"]]                # waits here
```

A generator, such as `sum(agent.count(x=x) for x in items)`, waits for each result
before it sends the next call.

These load as written, so their code gets the `Future` and has to call `.value()`:

- A module that imports no agent but calls one it is handed, such as
  `def run(agent): return agent.ask(q=q).upper()`.
- A file with a `# canyonos: no-rewrite` line.
- Every agent's modules, when `.env` sets `CANYONOS_LAZY_VALUES=0`.

## Endpoint

The endpoint serves one agent method over HTTP, chosen in the `endpoint:` block of the
workflow config. CanyonOS runs it in its own container; you write no server code. A
typical target is an agent that takes the request and calls the others:

```python
from pkg.agent import Agent


class Workflow:
    def main(self, query: str):
        agent = Agent()
        results = [agent.work(item=item) for item in query.split(",")]
        return [r for r in results if r["ok"]]
```

```yaml
endpoint:
  agent: Workflow
  method: main
```

List `main` in `Workflow`'s `functions`, with its arguments. The port and the other
endpoint settings are in [Workflow config](WORKFLOW_CONFIG.md#top-level-keys).
[Endpoint internals](../architecture/ENDPOINT.md) shows how a request travels.

### Requests

| Request                     | Body                                       | Answer                                                                                   |
| --------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `POST /<method>`            | A JSON object with every declared argument | `202` with `{"request_id"}`; `403` if [policy](#policy) refuses it; `400` for a bad body |
| `GET /status/<request_id>`  | None                                       | `200` with the status below; `404` for an unknown request                                |
| `POST /answer/<request_id>` | A JSON object with the answer's keys       | `202` once passed on; `409` when nothing is waiting; `400` for a bad body                |

In `POST /<method>`, each key becomes a keyword argument. `_context` is taken out first
and used for [policy](#policy); it must be a JSON object. A bad body is one that isn't
valid JSON or a JSON object, or that lacks a declared argument, so an empty body works
only for a method with no arguments. `canyonos test`, the `curl` example
`canyonos deploy` prints, and the dashboard take the argument names from the method's
`functions` entry, not from its signature.

`GET /status/<request_id>` answers with a `status`:

| `status`         | Meaning                                     | Other fields                                            |
| ---------------- | ------------------------------------------- | ------------------------------------------------------- |
| `pending`        | Still running                               | None                                                    |
| `done`           | Finished                                    | `result`                                                |
| `error`          | Failed or refused                           | `error`                                                 |
| `input_required` | An agent is waiting for the person's answer | `question`; see [Asking the person](#asking-the-person) |

### Results

- The method's result is sent as JSON. A result that isn't a `dict` is wrapped as
  `{"value": result}`. One that can't be converted fails the request with
  `its return value can't be converted to JSON`.
- A `Future` left in the result, at any depth of a `dict`, `list` or `tuple`, is
  replaced by its result, as the type its function declares under `returns`.
- CanyonOS waits up to 65 minutes for a `Future` passed as an argument or left in the
  result, and fails the call if no result comes by then.
- Each request runs at most once, on the replica that accepts it. It is not retried
  elsewhere: if that replica dies mid-run, the call fails with `ReplicaRemovedError`.

### Asking the person

Agent code asks the person who sent the request a question with the calls it already
uses, unchanged. During a request, each of these waits for the person's answer:

| Code                                                                                                                                                              | `input_schema`                                                            | What it gets back                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `input(prompt)`                                                                                                                                                   | `{"input": "str"}`                                                        | The answer's `input`, as JSON text when it isn't a string                                                                                                                                            |
| LangGraph `interrupt(value)`                                                                                                                                      | `{"input": "any"}`                                                        | The answer's `input`; no checkpointer or `Command(resume=...)` needed                                                                                                                                |
| LangGraph `interrupt(value, response_schema=bool)`, or any other type that isn't a model                                                                          | `{"input": "bool"}`                                                       | The answer's `input`, checked as that type                                                                                                                                                           |
| LangGraph `interrupt(value, response_schema=Review)` with a pydantic model, TypedDict or dataclass, and LangChain's human-in-the-loop middleware (`HITLResponse`) | Each field's type, such as `{"approved": "bool", "draft": "str \| None"}` | The answer built into the model                                                                                                                                                                      |
| OpenAI Agents SDK 0.12.1 or later: `Runner.run` / `Runner.run_sync` with tools that need approval                                                                 | `{"approve": "bool", "message": "str \| None"}`                           | A finished run. Each pending tool call is asked about: `{"approve": true}` approves it, and `{"approve": false}` rejects it with the answer's `message`, or the SDK's own message when there is none |
| `ask_human(question, input_schema)` from `human_input`                                                                                                            | `input_schema`                                                            | The whole answer as a dict, unchecked                                                                                                                                                                |

Outside a request, `input()`, `interrupt()` and `Runner` behave as they normally do,
and `ask_human` raises `RuntimeError`.

While an agent waits, `GET /status/<request_id>` answers `input_required`, with
`{"question": ..., "input_schema": ...}` in its `question` field: the question, and each
key the answer takes with its type. For an Agents SDK approval, the question is
`{"agent", "tool", "arguments"}`. The person answers with a JSON object of those keys at
`POST /answer/<request_id>`, such as `{"input": "1042"}`, and the request carries on.

| Rule                | Detail                                                                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Checking the answer | Each of these except `ask_human` asks again when the answer lacks a key or has a value of the wrong type                                               |
| Types shown         | Written the way a Python developer writes them. Unions, `Literal`s and nested models can show less precisely, and the answer is still checked          |
| JSON Schema         | A JSON Schema `response_schema` shows its `properties`, or `input` when it has none, and the answer isn't checked against it                           |
| TypedDict           | The images run Python 3.11, so use `typing_extensions.TypedDict`, as LangGraph itself requires                                                         |
| Order               | Questions waiting in one request are answered oldest first                                                                                             |
| Request ends first  | If the request finishes or fails before a question is answered, the waiting call raises                                                                |
| No answer           | After an hour, the waiting call raises `TimeoutError`                                                                                                  |
| Long waits          | The 65-minute wait for a `Future` still applies, so a call that asks two questions taking 40 minutes each makes its caller's wait raise `TimeoutError` |
| Slots               | The asking agent, and every call waiting on it, keep their thread slots until the answer comes                                                         |
| Replica loss        | If the asking replica dies while it waits, its call fails with `ReplicaRemovedError` and an answer sent afterwards is lost                             |
| Scale-down          | A scale-down that drains the asking replica fails the request once the drain's 180-second limit passes                                                 |

## Environment variables

On Docker, each agent replica gets the workflow's `.env` with `--env-file`; the
endpoint's container does not. An unreadable `.env` fails the deploy.
[What `.env` is for](BUILD_ARTIFACT.md#what-env-is-for) says where the file lives and
what else reads it. On Kubernetes, `.env` becomes a Secret; see
[Kubernetes deployment](KUBERNETES.md).

CanyonOS also sets these on each replica with `-e`, and they win over `.env`:

| Variable                                               | What it is                                                 |
| ------------------------------------------------------ | ---------------------------------------------------------- |
| `CANYONOS_REDIS_HOST`, `CANYONOS_REDIS_PORT`           | The workflow's Redis                                       |
| `CANYONOS_REDIS_PASSWORD`                              | The password the workflow's Redis requires                 |
| `CANYONOS_AGENT_HOST`, `CANYONOS_AGENT_PORT`           | Where this replica serves calls                            |
| `CANYONOS_REPLICA_ID`                                  | This replica's ID                                          |
| `CANYONOS_POLL_INTERVAL`                               | `poll_interval` from the workflow config                   |
| `CANYONOS_LOGS_ENABLED`                                | `logs` from the workflow config                            |
| `CANYONOS_SHUTDOWN_GRACE_SECONDS`                      | How long a draining replica has to finish                  |
| `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`                | Send model calls through the [LLM Gateway](LLM_GATEWAY.md) |
| `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, `AWS_CA_BUNDLE` | Trust the gateway's certificates                           |
| `AWS_ENDPOINT_URL_BEDROCK_RUNTIME`                     | Send boto3 Bedrock calls to the gateway                    |

A Redis client in your code that defaults to `localhost` reaches the container's own
loopback, not the workflow's Redis. Build it from `CANYONOS_REDIS_HOST`,
`CANYONOS_REDIS_PORT` and `CANYONOS_REDIS_PASSWORD`.

## Policy

`config/policy.yaml` decides which agents a request may reach, from the `_context`
object in the request body, such as `{"query": "...", "_context": {"tenant": "acme"}}`:

```yaml
rules:
  - match: {tenant: acme}
    access: [Workflow, PriceAgent]
  - match: {}
    access: all
```

| Rule             | Detail                                                                                                                           |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| No file          | Every request may reach every agent. So may an empty `rules: []`                                                                 |
| Rule order       | Rules with more `match` keys are tried first; the first rule whose keys all equal the request's `_context` decides               |
| `access`         | `all` allows every agent; otherwise the agent must be listed                                                                     |
| No matching rule | The call is denied                                                                                                               |
| Questions        | Calls to `endpoint`, which asking the person makes, are always allowed                                                           |
| Bad file         | An empty file, or `rules` that isn't a list of mappings, fails the deploy with an error naming the file. Nothing else is checked |

### Governance rules

`config/governance.yaml` adds two rules per agent, which you can then change on the
dashboard's **Governance** page:

```yaml
agents:
  PriceAgent:
    requires: [MarketData]
    spend:
      since: '2026-11-01T00:00:00Z'
      rules:
        - above_usd: 5
          action: {kind: switch_model, model: us.anthropic.claude-haiku-4-5-20251001-v1:0}
        - above_usd: 20
          action: {kind: deny}
```

| Key           | What it does                                                                         |
| ------------- | ------------------------------------------------------------------------------------ |
| `requires`    | Refuse calls to the agent while one of these agents has no healthy replica           |
| `spend.since` | Count the agent's spend from this time. Default: when the file is first published    |
| `spend.rules` | Thresholds in US dollars, each above 0. The highest one the spend has passed decides |
| `action.kind` | `deny` refuses calls; `switch_model` sends the agent's model calls to `action.model` |

The file only adds rules for agents that have none stored yet, so changes made on the
dashboard are kept when the file is published again. An invalid file fails the deploy.
[Switching model on spend](LLM_GATEWAY.md#switching-model-on-spend) covers which
models a switch can reach.

### Refusals

| `error_name`     | Cause                                                     |
| ---------------- | --------------------------------------------------------- |
| `PolicyDenied`   | No rule in `policy.yaml` allows the call for this request |
| `DependencyDown` | An agent in `requires` has no healthy replica             |
| `SpendLimit`     | The agent's spend passed a `deny` threshold               |

The controller on the machine that makes a call decides, from rules it reloads each
poll. A refused call never runs or queues. Its error text starts with its `error_name`:

```text
PolicyDenied: Policy denied the call to PriceAgent.get_price: no rule in policy.yaml allows it for this request.
```

The calling agent gets that error at the line that uses the call's result. A refused
request is answered `403` with `{"request_id", "error", "error_name"}`, and its
`GET /status` reports the same error.

## Deploy and stop

`canyonos deploy` follows the controller's log until the workflow is up, prints the
summary, and stops following. While it follows the log, Ctrl+C only stops the output,
and `canyonos logs` follows the log again. Ctrl+C before the Global Controller is up,
or a deploy that fails before the workflow is up, takes the deploy down.

`canyonos stop` asks the controller to remove every replica it recorded. A hard kill of
the controller can leave containers behind. The next `canyonos deploy` removes stopped
Redis and metrics containers and recreates leftover agent containers. A port you set
that is still in use is an error: an endpoint `api_port`, a `redis.port` or a database
`db_port`. [CLI](CLI.md#stop-and-clean-up) lists what `stop` and `clean` remove.
