# Runtime contract

How CanyonOS Core finds your code, wraps it in containers, calls it, and
tears it down. Nothing here is optional or environment dependent; the same
rules apply under every provider.

## Discovery

`canyonos deploy` reads everything from the [project root](BUILD_ARTIFACT.md).

| Input | Where |
|---|---|
| manifest | `config/global_controller.yaml` |
| agent functions | `functions` on an agent entry |
| entrypoint | `entrypoint` on an agent entry, relative to the project root |
| endpoint | `endpoint:` in the manifest, naming the agent method served over HTTP |
| policy | `policy.yaml` next to the manifest |
| generated files | `stubs/`, `grpc_stubs/`, `docker_container/` in the project root |

Two names have to agree for every agent:

```text
manifest entry name == class name in the entrypoint
```

A missing entrypoint file or a schema error stops the
deploy before anything is built. A class name that does not match is only
found when the container starts: the agent fails to load, the replica reports
`failed`, and `canyonos deploy` prints that container's log and fails.

## Agent functions and stubs

Each agent entry produces one Python stub: a class with the entry's name and
one method per function in its `functions`. Each method takes the declared
arguments as keywords, with no defaults, and returns a `Future` right away.
The stub imports nothing from your code, which is why argument and return
types are limited to builtins (see [Manifest reference](GLOBAL_CONTROLLER.md#agent-functions)).

The stub is written into every build context, including the agent's own, in
two places: at the agent's `entrypoint` path, and at the context root under
that path's basename. The build then copies the real entrypoint module to the
context root last, in that agent's own context only. So for
`entrypoint: pkg/agent.py`:

| Image | `/app/pkg/agent.py` | `/app/agent.py` |
|---|---|---|
| any peer | stub | stub |
| the agent's own | stub | real module |

The agent container loads `/app/agent.py`. Anything else in that image that
imports `pkg.agent` gets the stub, even inside the agent's own container.
An entrypoint at the root of the copy has one file, and the real module wins
there.

What the stub replaces is one module. Everything around it is real:

- The package `__init__.py` runs before the stub. If it re-exports a name
  from the stubbed module, every peer image raises `ImportError` at start.
  `canyonos validate` reports this as `CANYON-PACKAGE-REEXPORT`.
- Sibling modules are present, but only this entry's `requirements` are
  installed. Add what those siblings import to the entry that ships them.
- The stub defines the declared class and nothing else. Module constants,
  helper functions and other classes the original module exported do not
  exist in a peer image.

Two agents cannot share an entrypoint, because the second stub overwrites
the first. Two entrypoints in different directories with the same basename
collide at the context root the same way. Nothing checks either case up
front.

## Adapter shape

The entrypoint holds a module-level class named exactly like the manifest
entry. The controller does, in effect:

```python
module = load(entrypoint)
agent = getattr(module, configured_name)()
result = getattr(agent, method_name)(**args)
```

So:

- Construction takes no arguments.
- Declared methods take the `functions` argument names as keywords. Arguments
  travel as JSON, so an `int` stays an `int`. A `Future` passed as an
  argument is replaced by its result, which is always text. The declared `type`
  is never used to convert anything.
- Methods are called synchronously. An `async def` is not awaited, and its
  coroutine's `repr` is what lands in Redis. `canyonos validate` reports
  `CANYON-ADAPTER-ASYNC`.
- Calls run on a thread pool of 16 workers against one instance, so the
  instance is shared between concurrent requests. State on `self` needs to
  be safe for that, or the entry needs `replicas: 1` and `stateful: true`.
- A `dict` or `list` result is JSON-encoded before it enters Redis. Anything
  else becomes `str(result)`.

The module is loaded from `/app/<basename>.py` as a top-level module. It runs
as a normal import, so module-level code executes at container start, before
any request. Relative imports in the entrypoint itself fail with `attempted
relative import with no known parent package`, because the module has no
parent package. Modules it imports absolutely keep their own relative
imports.

An entrypoint path segment that is not a Python identifier (`06_agent.py`,
`travel-planner.py`) loads fine, since the controller loads by file path,
but a calling agent's `from steps.06_agent import X` is a `SyntaxError`.

If the import or the constructor raises, the controller marks the replica
`failed`, stops its gRPC server, kills the gateway, and exits. Readiness is
published only after the agent has loaded. Under `canyonos deploy` you see
the last lines of the container log between `--- begin container log` and
`--- end container log`.

## Endpoint

The endpoint serves an agent method over HTTP. A typical target is an agent that
takes the request and calls the others:

```python
import json
from pkg.agent import Agent


class Workflow:
    def main(self, query: str):
        agent = Agent()
        futures = [agent.work(item=item) for item in query.split(",")]
        return [json.loads(f.value()) for f in futures]
```

```yaml
agents:
  - name: Workflow
    entrypoint: workflow.py
    functions:
      - name: main
        arguments:
          - name: query
            type: str
        returns:
          type: list
```

The top-level `endpoint:` block in the manifest picks the method served
over HTTP:

```yaml
endpoint:
  api_port: 8080
  agent: Workflow
  method: main
```

CanyonOS runs the endpoint itself, in its own container on the machine that
runs `canyonos deploy`, and publishes it on `api_port` (default 8080, else the next free port).
[Endpoint](../architecture/ENDPOINT.md) shows how a request travels through it.
The agents' stubs and `ask_human` are the target agent's only imports of the platform.
`canyonos_core` inside the image holds the LLM gateway only, so importing
anything else from it raises `ImportError` at start.

Requests arrive as `POST /<method>` (`POST /main` above)
with a JSON object body. Every key becomes a keyword argument; `_context` is
popped first and used for policy. An empty body is a call with no
arguments. A body that is not a JSON object is a `400`. `canyonos test`, the
curl example `canyonos deploy` prints, and the dashboard take the argument
names from that method's `functions[].arguments`, not from its signature.

Each request runs the method as a future on a replica of the target agent, at
most once per delivery the replica accepts. A replica that dies mid-run loses
the request. The method takes one of that replica's
`CANYONOS_MAX_AGENT_INSTANCES` slots (default 16) and waits in line when all
are busy. `GET /status/<request_id>` reads that future: `pending` until it
finishes, then `done` with the result or `error` with the message, and
`input_required` with the question while an agent waits for the person. A
`Future` left in the returned value, at any depth of a dict, list or tuple,
is resolved before serialising. CanyonOS waits up to 65 minutes for the result
of a `Future` passed as an argument or left in the returned value, so a call
whose result is lost, for example because its replica died, fails after 65
minutes. Only the
`Future` object itself is resolved: `str(f)`, an f-string or
`json.dumps(...)` inside the method turns it into its `repr` first, so call
`.value()` on anything you format or parse. A result that is
not a dict is wrapped as `{"value": result}`. A result that cannot be
serialised as JSON fails the request with `... is not JSON serializable`.

Each stub method returns a `Future` immediately and `.value()` blocks. The
value is the text the agent stored, so a dict comes back as a JSON string.
Dispatching and resolving inside one comprehension serialises the calls
without any error; dispatch everything first, then resolve.

### Asking the person

Agent code asks the person who sent the request a question the way it already
does, with no changes. During a request each of these waits for the person's reply:

| Code | `input_schema` | What it gets back |
|---|---|---|
| `input(prompt)` | `{"input": "str"}` | the reply's `input`, as JSON text when it isn't a string |
| LangGraph `interrupt(value)` | `{"input": "any"}` | the reply's `input`; no checkpointer or `Command(resume=...)` needed |
| LangGraph `interrupt(value, response_schema=bool)`, or any other type that isn't a model | `{"input": "bool"}` | the reply's `input`, checked as that type |
| LangGraph `interrupt(value, response_schema=Review)` with a pydantic model, TypedDict or dataclass, and LangChain's human-in-the-loop middleware (`HITLResponse`) | each field's type, such as `{"approved": "bool", "draft": "str \| None"}` | the reply built into the model |
| OpenAI Agents SDK 0.12.1 or later: `Runner.run` / `Runner.run_sync` with tools that need approval | `{"approve": "bool", "message": "str \| None"}` | a finished run: each pending tool call is asked about, `{"approve": true}` approves it, `{"approve": false}` rejects it with the reply's `message`, or the SDK's own message when there is none |
| `ask_human(question, input_schema)` from `human_input` | `input_schema` | the whole reply as a dict, unchecked |

Each of these but `ask_human` asks again when a reply is missing a key or has a
value that doesn't fit its type. Types show as a Python developer writes them;
unions, `Literal`s and nested models can show less precisely, and the agent still
checks the reply. A JSON Schema `response_schema` shows its `properties`, or `input`
when it has none, and the reply isn't checked against it. The agent images run
Python 3.11, so a TypedDict schema needs `typing_extensions.TypedDict`, not
`typing.TypedDict`; LangGraph itself requires this.

While it waits, `GET /status/<request_id>` answers `input_required`, with
`{"question": ..., "input_schema": ...}` in its `question` field: the question, and
each key the answer takes with its type. The person answers with a JSON object of
those keys at `POST /answer/<request_id>`, such as `{"input": "1042"}`; the agent gets
that body, and the request carries on. The endpoint answers `202` once it passes the
answer on, `409` when nothing is waiting, and `400` when the body isn't a JSON object.
Questions waiting in the same request are answered oldest first. If the request
finishes or fails before a question is answered, that question fails and the waiting
call raises. A question with no answer after an hour makes the waiting call raise
`TimeoutError`. CanyonOS waits at most 65 minutes for a `Future` passed as an argument
or left in the returned value, so a call that runs longer, for example by asking two
questions that each take 40 minutes, makes that wait raise `TimeoutError`. The asking
agent, and every call waiting on it, keep their slots until the answer comes. A
replica that dies meanwhile loses the request, and an answer sent to it is lost too.
A scale-down that drains the asking replica fails the request once the drain's
180 s limit passes.

## Build context

Each build context starts as a copy of the project root with relative paths kept,
minus what the sweep excludes, and then gets the platform's runtime modules,
the generated gRPC modules, `canyonos_core/llm_gateway`, every stub, and the
agent's own entrypoint written on top. [Images and
dependencies](IMAGES_AND_DEPENDENCIES.md) lists the exclusions and the file
names that get overwritten.

## Dependencies and protobuf

Each image installs `grpcio>=1.76.0`, `protobuf>=6.31.1`, `redis>=3.5`,
plus the entry's own `requirements`.
The `*_pb2.py` modules are generated by the controller image's `protoc` and
copied into every image. They check the protobuf floor at import, so the
build forces `protobuf>=6.31.1` and fails early if a requirement pins below
it. `uv pip check` runs after install and prints a note on conflicts.

A `requirements` entry that is not a single PEP 508 requirement is a schema
error and the deploy is rejected. Requirements above the tested major of a
base package only warn.

## Credentials

`.env` in the project folder, when there is one, is passed to each agent
replica as `--env-file`; the endpoint does not get it. [Project
layout](BUILD_ARTIFACT.md#what-env-is-for) says where it lives and what else
reads it. An unreadable file fails the deploy first. Hidden files never reach
an image, so `.env` itself stays out of the copy.

The runtime also sets `CANYONOS_REDIS_HOST`, `CANYONOS_REDIS_PORT`,
`CANYONOS_AGENT_HOST`, `CANYONOS_AGENT_PORT`, `CANYONOS_POLL_INTERVAL`,
`CANYONOS_LOGS_ENABLED` and the six LLM gateway variables with `-e`, which win
over the file. A Redis client in your code that defaults to `localhost`
connects to the container's own loopback, not to the platform's Redis; build
it from `CANYONOS_REDIS_HOST` and `CANYONOS_REDIS_PORT` instead.

## Policy

No `policy.yaml` means every caller may reach every agent. With a file,
`rules` is a list of `{match: {...}, access: [...] | all}`. The controller
sorts rules by how many keys `match` has, most specific first, and takes the
first rule whose keys all equal the request's `_context`. `access: all`
allows everything; otherwise the agent has to be listed. Calls to
`endpoint`, which `ask_human` makes, are always allowed. No matching rule
denies. A denied call never runs: it fails with
`PolicyDenied: Policy denied the call to <Agent>.<method>`.

The file is not schema-checked. An empty file, or `rules:` that is not a list
of mappings, fails the deploy with an error naming the file.

`config/governance.yaml` adds two per-agent rules, which the dashboard edits
afterwards. `requires: [OtherAgent]` refuses calls to the agent while
`OtherAgent` has no healthy replica, with `error_name` `DependencyDown`.
`spend.rules` lists `{above_usd, action}` thresholds on the agent's spend since
`spend.since` (the deploy, when the file leaves it out); the highest threshold
passed wins. `action: {kind: deny}` refuses calls with `SpendLimit`;
`{kind: switch_model, model: <id>}` sends the agent's LLM calls to that model.
A policy refusal has `error_name` `PolicyDenied`.

Every refusal is decided once, by the controller on the machine that makes the
call, from rules it re-reads each poll. A refused call is never queued and its
error text starts with its `error_name`; the agent that made it gets that error
from `.value()`. A refused root call is answered `403` with
`{"request_id", "error", "error_name"}` instead of `202`, and its `/status`
reports the same error. The governance file seeds only agents the
stored rules lack, so dashboard edits survive a redeploy; an invalid file fails
the deploy.

## Stopping and cleaning

`canyonos deploy` tails the controller log until the workflow is up, then
prints the summary and stops tailing. From then on Ctrl+C only stops the
tail; `canyonos logs` reattaches. Ctrl+C while still syncing or starting, or
a failed deploy, tears the deployment down.

`canyonos stop` asks the controller to remove every replica it
recorded. A hard kill of the controller can leave containers behind; the
next `canyonos deploy` removes stale Redis and metrics containers and
recreates orphaned agent containers, but an endpoint `api_port` you set, a database
`db_port` or a `redis.port` you set, still in use, is a hard error.

`canyonos clean` stops the project if it is deployed, then deletes the
`.canyon` directory in the current directory, if there is one, removes the skill `canyonos convert`
installed in this project (a global install is kept), and removes the local
Docker image (`canyonos-<project>-<agent>`) of each agent in this project's
`global_controller.yaml`. Other projects' images stay. It never touches `.env`.
