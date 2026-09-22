# CanyonOS Core runtime contract

**Purpose:** explain discovery, generated stubs, loading, execution, image
assembly, and cleanup, and the adapter/workflow shape that contract requires
to be written by hand.

The product is CanyonOS Core and its user-facing CLI is `canyonos`. The
internal Python package, runtime variables, and Docker resources are
`canyonos_core`, `CANYONOS_*`, and `canyonos-*`.
Nothing below varies by environment: the runtime has no optional behavior to
probe for, and the gap validator checks every rule on every run.

## Contents

- Artifact root and discovery
- Agent yaml and generated stubs
- Writing the adapter and workflow
- Agent loading and execution
- Workflow execution
- Build context and collisions
- Dependencies and protobuf
- Credentials
- Policy and provider behavior
- Cleanup boundary

## Artifact root and discovery

The build phase of `canyonos deploy` runs from the application root and reads
`.car` below it. That artifact root holds `config/` beside `app/`, the copy of
the application source that becomes `/app` inside every image. Paths in the
config are relative to `app/` and may not escape it.

| Input | Discovery |
|---|---|
| agent declarations | any `.car/config/*.yaml` with a top-level `agent.name` |
| `.car/config/global_controller.yaml` | default config, overridable with `-c` |
| entrypoint | `entrypoint` on an agent entry, relative to `app/` |
| workflow | `workflow_file` on a `type: workflow` entry, relative to `app/` |
| policy | `policy.yaml` beside the selected config file |
| generated files | `stubs/`, `grpc_stubs/`, `docker_container/`, all under `.car` beside `app/` |

Because build products sit next to the copy rather than inside it, an
application directory named `stubs/` or `build/` survives into the image.

The config name, yaml `agent.name`, and entrypoint class name form one binding:

```text
config entry name == yaml agent.name == entrypoint class name
```

A missing match may skip an image while the command continues, so inspect build
output and generated image tags.

## Agent yaml and generated stubs

The consumed yaml shape is:

```yaml
agent:
  name: ExampleAgent
  functions:
    - name: work
      arguments:
        - name: query
          type: str
      returns:
        type: dict
```

Argument annotations are generated from bare names without adding imports. Use
builtins. Generated methods have no defaults, so every declared argument is
required at the stub call site. `returns` does not control runtime conversion;
it documents whether workflow code should parse the returned string.

A stub has exactly one destination: the agent's own `entrypoint` path. In every
image except that agent's own, the stub is written over the real module there,
so an import of the agent from its source location resolves to the stub and
travels over gRPC. The agent's own image keeps its real module and receives
only its peers' stubs. Gap validation checks workflow imports against those
entrypoints before the workflow image starts.

The `entrypoint` path is the whole of it. The declaration file's own basename
names neither the stub nor the agent, and has no runtime meaning beyond being
discovered in `config/`.

What the stub replaces is one whole module, and everything else in the copy
still runs around it. In a peer image:

- the entrypoint's package `__init__.py` is real and runs before the stub is
  reached, so a re-export from the stubbed module (`from .graph import graph`)
  raises ImportError at container startup -- V033;
- the entrypoint's sibling modules are real, so that image installs *their*
  dependencies even though its own code never names them -- W006;
- the stub defines the declared class and nothing else: no module-level
  constants, no helper functions, no other class the source module exported.

The third has no static check. Read what the workflow imports out of that
module.

## Writing the adapter and workflow

**Output:** one loadable adapter per service and one workflow exposing
`main(query: str)`.

Use this order:

1. Choose a safe entrypoint module for each service.
2. Write a no-argument synchronous adapter around source-owned behavior.
3. Bridge async or session state only when the source requires it.
4. Write the workflow and preserve parallel dispatch.

Complete the manifest (see [manifest-reference](manifest-reference.md)), then
validate only the authored contracts that CanyonOS does not already
guarantee.

These rules are required even when static checks pass; violations often appear
only when a container loads.

### Adapter and workflow shape

Write a no-argument, synchronous adapter class at the selected entrypoint.
Import source-owned behavior instead of duplicating it. The workflow exposes
`main(query: str)`, imports every service from its exact entrypoint module, and
calls `deploy(main, port=...)` at module scope. Do not add a main guard: the
workflow executes as `__main__` in production.

Its imports of the platform itself are exactly these two:

```python
from deploy import deploy                 # runtime module, copied flat into the image
from pkg.price_agent import PriceAgent    # the service, from its declared entrypoint
```

`canyonos_core` is not an importable API in the image: the package the build
writes there holds the LLM proxy alone, under an `__init__` that exports
nothing. `from canyonos_core import deploy` builds green and raises ImportError
at container start. V021.

For parallel remote calls, dispatch all work before resolving any result:

```python
futures = [agent.work(item=item) for item in items]
results = [json.loads(future.value()) for future in futures]
```

Combining dispatch and `.value()` in one comprehension serializes the work.

### Choosing the entrypoint

The entrypoint is the one module in the copy the build destroys: each agent's
stub is written over its own `entrypoint` path in every image except that
agent's own, so everywhere else that path holds a generated class and nothing
else. Every gate below applies to whichever module you pick; each one
disqualifies it as it stands, so fix the module or point `entrypoint` at
another.

1. **Does anything else the deployment imports read this module for its real
   contents?** The workflow, or any module the workflow imports at module scope.
   If yes, the stub replaces it there and the workflow dies at container
   startup. Put the adapter in a sibling module that imports this one and point
   `entrypoint` at the sibling. This is why "edit the copied module in place" is
   a preference and not a rule: it is right only for a module nothing else
   imports.
2. **Does the module's package `__init__.py` re-export a name from it?**
   (`from .graph import graph`) Python runs `__init__.py` before any submodule,
   so every peer image that touches that package re-runs a re-export the stub
   cannot satisfy and raises ImportError at startup. Point `entrypoint` at a
   module the `__init__` does not re-export from; add one if it re-exports from
   all of them. V033.
3. **Is every segment of the path a Python identifier?** `travel-planner.py` and
   `steps/06_agent.py` load fine -- the controller loads by file path -- but the
   workflow's `from steps.06_agent import X` is a SyntaxError, which no import
   guard catches. Rename the file inside the copy, or add a normally-named
   sibling that loads it by path and re-exposes the class. V034.
4. **Does the module use relative imports?** (`from . import data_service`) The
   controller loads the entrypoint with `spec_from_file_location`, which leaves
   `__package__` empty, so every relative import *in the entrypoint itself*
   fails at agent load. Make its top-level imports absolute; the modules it
   imports keep theirs. V035.
5. **Does module-level code perform a real run?** A script ending in
   `result = crew.kickoff(...)` / `print(result)` fires that run whenever the
   module loads, before a request exists. Delete the
   invocation and keep the construction. The source-integrity boundary (see
   [build-artifact](build-artifact.md)) protects prompts, tools, schemas, model
   calls, and node bodies -- not a script's own main body.

### Bridging async

Use one `asyncio.run(...)` per declared method, at the method boundary, around
the whole call. One per awaited coroutine builds a fresh event loop and a fresh
connection pool per graph superstep.

If the instance holds anything bound to a loop -- an `asyncio.Lock`, a client
constructed inside a coroutine -- `asyncio.run` cannot be used at all. The
runtime calls declared methods repeatedly on one instance, and the second call
raises `Lock is bound to a different event loop`. Run one persistent loop on a
background thread and submit with `run_coroutine_threadsafe`. Seed any
`ContextVar` the source's async code reads on the calling thread immediately
before submitting: `call_soon_threadsafe` copies the context at schedule time,
not inside the loop.

### Multi-turn and session state

The platform sends one `{query: string}` per request and keeps nothing between
them. A source with per-conversation state -- a `thread_id`, a checkpointer, a
memory keyed by session -- carries that id *inside* `query`: accept either a
bare string or a JSON object in that one field and pass the id through to the
source unchanged. Do not add a second workflow parameter for it; the platform
never sends one.

## Agent loading and execution

The local controller effectively performs:

```python
module = load(entrypoint)
agent_class = getattr(module, configured_name)
agent = agent_class()
result = getattr(agent, method_name)(**args)
```

Consequences:

- The class is module-level and named exactly as configured.
- Construction takes no arguments.
- The module name is `CANYONOS_AGENT_FILE` with `.py` stripped -- directory
  separators and all -- so an entrypoint at `pkg/agent.py` loads as the module
  `pkg/agent`, which has no parent package. Relative imports in the entrypoint
  raise `attempted relative import with no known parent package`; modules it
  imports absolutely are unaffected. V035.
- Declared methods accept yaml argument names as keyword arguments.
- Methods are synchronous; this path does not await a coroutine.
- Dicts and lists are JSON-encoded before entering Redis; other results become
  strings.
- A remote Future's `.value()` returns text, not the original Python object.

Agent import and construction exceptions are caught by the controller. A failed
agent may still advertise healthy because health is written independently of
successful agent loading. After an explicitly approved deployment, inspect
container logs rather than treating health as proof that the entrypoint loaded.

## Workflow execution

The workflow file is executed, not imported. Therefore:

- module-level code runs at container startup;
- `__name__ == "__main__"`;
- `deploy()` blocks in the web server;
- the workflow function runs once per request;
- its function name determines the REST route exposed by the compatibility
  runtime.

The deployment platform additionally expects `/main` with a `{query: string}`
body. This platform constraint is stricter than the underlying transport.

Each stub method returns a Future immediately. `.value()` blocks. Dispatching
and resolving inside one comprehension serializes work without raising an
error; dispatch all calls first, then resolve them.

The workflow container also starts runtime controller code and has its own
package resolution. A failure there can differ from failures in agent images.

## Build context and collisions

The runtime sweeps every file under `app/` while preserving relative paths,
then writes shared runtime modules, generated stubs, and entrypoints on top.
Later writes shadow swept files. The sweep holds back hidden paths, symlinks,
private key material, bytecode, the build's own generated directories, and the
three names the build context owns (`Dockerfile`, `requirements.txt`,
`workflow_launcher.py`), printing one note per exclusion.

Each stub is written twice: over the agent's `entrypoint` path, and at the
context root under that path's basename. Both modules hold the stub in every
image except the agent's own, where the real entrypoint is copied to the
context root last and wins.

Avoid modules at the root of the copy named like runtime files, including:

```text
future.py
canyonos_context.py
local_controller.py
local_controller_frontend.py
redis_client.py
grpc_options.py
bedrock.py
deploy.py
session_logging.py
workflow_launcher.py
```

Two agents also may not share one entrypoint: each stub is written over its own
entrypoint, so the second lands on the first and every caller reaches whichever
was built last. Gap validation checks both collisions.

No image runs an editable install. For nested imports, see
[images-and-dependencies](images-and-dependencies.md).

## Dependencies and protobuf

Agent and workflow images include a small runtime dependency set. Config
`requirements` adds source-specific distributions. A malformed requirements
value can be normalized away while image generation continues; missing imports
then surface only when the agent loads.

The build compiles gRPC Python stubs on the host and copies them into images.
The image resolver does not necessarily know the generated-code version. A
source dependency that constrains protobuf below the host generator version can
produce a green image build that dies on:

```text
import local_controller
```

Treat a generated-code/runtime-version mismatch during an explicitly approved
`canyonos deploy` as a CanyonOS Core runtime issue, not a reason to alter source
dependencies silently.

## Credentials

Every deployment resolves `env_file` and passes it at container start. The path
is resolved against the application root -- the directory the command runs from,
not `.car` -- so a `.env` beside the source stays out of the artifacts. Hidden
env files are not copied into images. Invalid paths are deploy-preflight errors.

A source that needs credentials gets them this way. Never hardcode or vendor a
secret instead; the sweep would bake it into every image.

A source that constructs its client at import time works only when credentials
are already in the container environment. After an explicitly approved deploy,
check loading failures against the same env file configured for deployment.

For proxy-specific credential separation, read [llm-proxy](llm-proxy.md).

## Policy and provider behavior

No policy file means unrestricted service access. If a policy exists, it needs a
non-empty rules list. Rules are evaluated by specificity and first match;
services excluded from the selected rule fail after request acceptance.

Local provider handling is case-sensitive: use lowercase `local`. EC2 behavior
and remote networking are covered in [ec2](ec2.md).

## Cleanup boundary

`canyonos deploy` follows controller logs after starting the deployment. Ctrl+C
stops that log stream; use `canyonos stop` to request controller teardown when
the user asks to stop the deployment. Hard kills and failures before resource
registration may leave resources behind.

`canyonos clean` removes generated `stubs/`, `grpc_stubs/`, and
`docker_container/`; it does not remove containers or images. Remove exact
leftovers explicitly and preserve `.car/app`, `.car/config`, and requested
evidence.
