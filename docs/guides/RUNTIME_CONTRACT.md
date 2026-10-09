# Runtime contract

How CanyonOS Core finds your code, wraps it in containers, calls it, and
tears it down. Nothing here is optional or environment dependent; the same
rules apply under every provider.

## Discovery

`canyonos deploy` runs from the application root and reads `.car` below it.

| Input | Where |
|---|---|
| manifest | `.car/config/global_controller.yaml`, or the file given with `-c` |
| agent declarations | any `.car/config/*.yaml` with a top-level `agent.name` |
| entrypoint | `entrypoint` on an agent entry, relative to `.car/app` |
| workflow | `workflow_file` on the `type: workflow` entry, relative to `.car/app` |
| policy | `policy.yaml` next to the manifest |
| generated files | `stubs/`, `grpc_stubs/`, `docker_container/` under `.car` |

Three names have to agree for every agent service:

```text
manifest entry name == yaml agent.name == class name in the entrypoint
```

A missing declaration, a missing entrypoint file, or a schema error stops the
deploy before anything is built. A class name that does not match is only
found when the container starts: the agent fails to load, the replica reports
`failed`, and `canyonos deploy` prints that container's log and fails.

## Agent yaml and stubs

Each declaration produces one Python stub: a class with the declared name and
one method per declared function. Each method takes the declared arguments as
keywords, with no defaults, and returns a `Future` right away. The stub
imports nothing from your code, which is why argument types are limited to
builtins (see [Manifest reference](GLOBAL_CONTROLLER.md#agent-declarations)).

The stub is written into every build context, including the agent's own, in
two places: at the agent's `entrypoint` path, and at the context root under
that path's basename. The build then copies the real entrypoint module to the
context root last, in that agent's own context only. So for
`entrypoint: pkg/agent.py`:

| Image | `/app/pkg/agent.py` | `/app/agent.py` |
|---|---|---|
| any peer, and the workflow | stub | stub |
| the agent's own | stub | real module |

The agent container loads `/app/agent.py`. Anything else in that image that
imports `pkg.agent` gets the stub, even inside the agent's own container.
An entrypoint at the root of the copy has one file, and the real module wins
there.

What the stub replaces is one module. Everything around it is real:

- The package `__init__.py` runs before the stub. If it re-exports a name
  from the stubbed module, every peer image raises `ImportError` at start.
  `canyonos validate` reports this as `CAR-PACKAGE-REEXPORT`.
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
- Declared methods take the yaml argument names as keywords. Arguments
  travel as JSON, so an `int` stays an `int`. A `Future` passed as an
  argument is replaced by its result, which is always text. The yaml `type`
  is never used to convert anything.
- Methods are called synchronously. An `async def` is not awaited, and its
  coroutine's `repr` is what lands in Redis. `canyonos validate` reports
  `CAR-ADAPTER-ASYNC`.
- Calls run on a thread pool of eight workers against one instance, so the
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
but the workflow's `from steps.06_agent import X` is a `SyntaxError`.

If the import or the constructor raises, the controller marks the replica
`failed`, stops its gRPC server, kills the gateway, and exits. Readiness is
published only after the agent has loaded. Under `canyonos deploy` you see
the last lines of the container log between `--- begin container log` and
`--- end container log`.

## Workflow shape

The workflow file is executed, not imported. Its module-level code runs at
container start with `__name__ == "__main__"`, so a `if __name__ ==
"__main__":` guard runs too, and its `deploy(fn, port=...)` call blocks in
the web server.

```python
import json
from deploy import deploy
from pkg.agent import Agent

agent = Agent()

def main(query: str):
    futures = [agent.work(item=item) for item in query.split(",")]
    return [json.loads(f.value()) for f in futures]

deploy(main, port=8080)
```

`deploy` and the agents are the workflow's only imports of the platform.
`canyonos_core` inside the image holds the LLM gateway only, so
`from canyonos_core import deploy` raises `ImportError` at start.

Requests arrive as `POST /<function name>` with a JSON object body. Every
key becomes a keyword argument; `_context` is popped first and used for
policy. An empty body is a call with no arguments. A body that is not a JSON
object is a `400`. `canyonos test` and the curl example `canyonos deploy`
prints derive the route and the parameter from your function. The managed
platform's test endpoint posts to `/main` with `{"query": "..."}` only, so a
workflow meant for it needs a function named `main` with a single `query`
parameter, and everything else carried inside that string. Parse richer
input out of it inside `main` (`int(query)`, `json.loads(query)`); a session
or conversation id travels inside `query` too.

Each request runs `main` once as a future on the local controller, the same
way an agent call runs, so it takes one of the controller's
`CANYONOS_MAX_AGENT_INSTANCES` slots (default 16) and waits in line when all
are busy. `GET /status/<request_id>` reads that future: `pending` until it
finishes, then `done` with the result or `error` with the message. A
`Future` left in the returned value, at any depth of a dict, list or tuple,
is resolved before serialising. Only the
`Future` object itself is resolved: `str(f)`, an f-string or
`json.dumps(...)` inside `main` turns it into its `repr` first, so call
`.value()` on anything you format or parse. A result that is
not a dict is wrapped as `{"value": result}`. A result that cannot be
serialised as JSON fails the request with `workflow '<name>' returned a
result that cannot be sent as JSON`.

Each stub method returns a `Future` immediately and `.value()` blocks. The
value is the text the agent stored, so a dict comes back as a JSON string.
Dispatching and resolving inside one comprehension serialises the calls
without any error; dispatch everything first, then resolve.

The workflow container also runs the local controller that runs `main` and
its own LLM gateway, so a failure there can differ from one in an agent image.

## Build context

Each build context starts as a copy of `.car/app` with relative paths kept,
minus what the sweep excludes, and then gets the platform's runtime modules,
the generated gRPC modules, `canyonos_core/llm_gateway`, every stub, and the
service's own entrypoint written on top. [Images and
dependencies](IMAGES_AND_DEPENDENCIES.md) lists the exclusions and the file
names that get overwritten.

## Dependencies and protobuf

Each image installs `grpcio>=1.76.0`, `protobuf>=6.31.1`, `redis>=3.5`,
plus `flask>=2.3.3` for the workflow, plus the entry's own `requirements`.
The `*_pb2.py` modules are generated by the controller image's `protoc` and
copied into every image. They check the protobuf floor at import, so the
build forces `protobuf>=6.31.1` and fails early if a requirement pins below
it. `uv pip check` runs after install and prints a note on conflicts.

A `requirements` entry that is not a single PEP 508 requirement is a schema
error and the deploy is rejected. Requirements above the tested major of a
base package only warn.

## Credentials

`env_file` in the manifest is resolved against the directory `canyonos
deploy` runs from and passed to every container as `--env-file`. A missing or
unreadable file fails the deploy first. An empty file is skipped. Hidden
files never reach an image, so `.env` at the root of the copy stays out.

The runtime also sets `CANYONOS_REDIS_HOST`, `CANYONOS_REDIS_PORT`,
`CANYONOS_AGENT_HOST`, `CANYONOS_AGENT_PORT`, `CANYONOS_POLL_INTERVAL`,
`CANYONOS_LOGS_ENABLED` and the six LLM gateway variables with `-e`, which win
over the file. A Redis client in your code that defaults to `localhost`
connects to the container's own loopback, not to the platform's Redis; build
it from `CANYONOS_REDIS_HOST` and `CANYONOS_REDIS_PORT` instead.

In a managed deployment the platform's secrets file replaces `env_file`.

## Policy

No `policy.yaml` means every caller may reach every service. With a file,
`rules` is a list of `{match: {...}, access: [...] | all}`. The controller
sorts rules by how many keys `match` has, most specific first, and takes the
first rule whose keys all equal the request's `_context`. `access: all`
allows everything; otherwise the service has to be listed. No matching rule
denies. A denied call fails after the request was accepted, with
`Unauthorized: Policy denied access to service`.

The file is not schema-checked. An empty file or `rules:` with no list
crashes the controller with an `AttributeError`.

## Stopping and cleaning

`canyonos deploy` tails the controller log until the workflow is up, then
prints the summary and stops tailing. From then on Ctrl+C only stops the
tail; `canyonos logs` reattaches. Ctrl+C while still syncing or starting, or
a failed deploy, tears the deployment down.

`canyonos stop` asks the controller to drain and remove every instance it
recorded. A hard kill of the controller can leave containers behind; the
next `canyonos deploy` removes stale Redis and metrics containers and
recreates orphaned agent containers, but a workflow `api_port`, a database
`db_port` or a Redis port still in use is a hard error.

`canyonos clean` deletes the entire `.car` directory in the current
directory, including `app/` and `config/`, strips the `CANYONOS_*` keys
`canyonos serve` wrote to `.env`, removes the skill `canyonos build`
installed in this project (a global install is kept), and removes every
local Docker image named `canyonos-*`. It does not touch containers; use
`canyonos stop` or `canyonos quit` for those.
