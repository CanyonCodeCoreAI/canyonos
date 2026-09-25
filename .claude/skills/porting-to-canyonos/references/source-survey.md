# Survey the copied source

**When:** after `prepare.py`, before writing adapters or configuration.

**Inspect:** `.car/app`, not a framework-based guess about the original tree.

**Output:** a short survey record and a service map with one service per
agent. Do not start adapter or config work until the readiness gate passes and
each section is resolved. A blocker pauses the build, not just the survey
checklist.

## Application-readiness gate

Read [Preparing an Agent App for CanyonOS](https://github.com/CanyonCodeCoreAI/canyonos/blob/5cd4fa8c51082e414aad64e27283ba50c27c579f/docs/CANYONIZATION-APP-READINESS.md)
and check the selected serving path against its requirements before adapting
it. Use the target image's dependency baseline rather than copying version
numbers from the guide.

Pause the build when a required source capability cannot run within CanyonOS:
interactive or device-dependent serving, Docker inside the agent, unsupported
required model routing, incompatible dependencies or resource requirements,
unavailable required services/data, or a demonstrated source install, import,
or request failure. Check the actual serving path: an unused demo or optional
integration is not a blocker.

Do not silently remove required behavior, switch providers, fabricate data,
or repair source defects to make the port pass. Stop adapting when a blocker
is found, even if static validation could pass. Use the blocked handoff in
`validation-and-deploy.md`: identify the source evidence, the developer action
needed to resume, and a link to the relevant section of the readiness guide.
Do not report build success or recommend test/deploy while it remains blocked.

Credentials that only need filling in before test/deploy belong in the final
env reminder, not a build blocker. Record their names from source and
`.env.example`; never read `.env` or request secret values. Pause if missing
configuration, services, or data prevents determining or preparing the port.

## 1. Public behavior

Record:

- the production entrypoint and callable input/output;
- the documented route, CLI, or launch path that proves this is the entrypoint;
- prompts, tools, schemas, parsing, retries, model clients, and node bodies that
  remain source-owned.

If multiple implementations look plausible, trace imports from the documented
launch path instead of choosing by filename.

## 2. Control flow and state

Record:

- framework-owned graphs, crews, chats, routing, fan-out, commands, and
  interrupts;
- independent work that may justify separate resources or replicas;
- injected stores, context, memory, sessions, checkpointers, and callback
  managers;
- sync/async boundaries and objects tied to an event loop.

This evidence feeds the service-boundary decision below and `adapter.md`.

## 3. Imports and runtime inputs

Record:

- the transitive import graph from the selected entrypoint;
- source lockfiles and pinned runtime distributions;
- whether every import resolves with `.car/app` mounted as `/app`;
- model providers, credential variable names, streaming calls, and `llm_proxy`
  routing -- required by default whenever the source calls an OpenAI,
  Anthropic, or Bedrock model API (see `llm-proxy.md`), not just when the
  source or deployment already shows it. Read the source's `os.environ` and
  `.env.example`, never `.env`;
- non-Python files opened at runtime: prompts, framework YAML, PDFs, templates,
  schemas, certificates, and corpora.

Use the import-root and runtime-assets sections of `preparation.md` when imports
do not resolve, packaging metadata matters, or runtime code reads non-Python
files.

## 4. Runtime questions

The runtime has no optional behavior to probe for: every image sweeps the whole
copy, none of them runs an editable install, and `env_file` is passed on every
deployment. Record instead what this source needs from those fixed facts -- an
import that only resolves from a nested root, an asset the sweep drops, a
credential name.

An existing syntax error on the selected import graph is a source defect;
pause the build and identify the required source fix. The final gap validator
checks authored runtime code and cross-file bindings after the port is
complete.

## 5. Choose service boundaries

**Output:** one service per agent, the graph edges that move into the workflow,
and which services require `replicas: 1`.

LangChain defines what an agent is; LangGraph defines how agents are
orchestrated. Each LangChain agent becomes a service, and the LangGraph graph
around them becomes the workflow. A plain Python source with no framework is
split the same way; see "Plain Python sources" below.

### What counts as an agent

An agent is a LangChain agent: a model that calls tools in a loop until it
produces an answer. Class and node names are not evidence: a
`ChiefEditorAgent` that builds and runs a graph is orchestration, and a
`PublisherAgent` that only formats and writes files is a plain step.

Each of these is one agent, including its internal model/tools loop. Do not
split its tools node.

- An agent built by `create_agent`, or by the older `create_react_agent` or
  `AgentExecutor`.
- A hand-built equivalent: a model node bound to tools, a `ToolNode`, and a
  `tools_condition` (or equivalent) edge looping between them.

None of these is an agent:

- A tool, including one that wraps another agent. A subagent called as a tool
  stays inside the agent that calls it.
- A model call outside an agent loop: `llm.invoke`, a chain such as
  `prompt | llm | parser`, or `with_structured_output`, including a supervisor
  or router that picks the next node. It runs in the workflow, which has its
  own `llm_proxy`.
- An edge router, a pure transform, formatting, or file I/O.

A node that waits on a person or device during the request (`input()`, a
websocket receive, `interrupt()`) is a readiness blocker, not a service; see
the application-readiness gate above.

### Services and the workflow

The service method is the graph node that runs the agent: the compiled agent
itself when it is added as a node, or the node function that invokes it.

Everything else in the graph is orchestration and becomes the workflow:
`StateGraph` construction, edges, conditional edges, `Command(goto=...)`
handoffs, and `Send` fan-out. Re-express it as ordinary Python, and import the
remaining node functions and routers from the source unchanged.

If the graph holds no agent or a single agent, do not split it: preserve
`graph.compile().invoke(...)` and wrap it as one service.

### Plain Python sources

A source that calls a model SDK directly, with no LangChain or LangGraph, is
split by the same rules. Only the evidence changes:

- **Agent:** a function or method that runs the model/tools loop itself. It
  calls the model, executes the tool calls the model returns, feeds the results
  back, and repeats until the model gives a final answer. That function or
  method is the service method.
- **Orchestration:** the Python code that calls agents in sequence, branches or
  loops on their outputs, or fans them out with `asyncio.gather`, a thread
  pool, or similar. It becomes the workflow.
- **Not agents:** a single model call outside such a loop, tools, and pure
  transforms. They run in the workflow or stay inside the agent that calls
  them, exactly as above.

If the source holds no agent or a single agent, wrap its entrypoint function as
one service.

Construct runtime-injected service objects from source configuration. Never
invent models, embedding dimensions, stores, or defaults silently; report any
choice the source does not specify.

A service object that holds state across requests—for example a vector store,
memory, or checkpointer created in `__init__`—requires `replicas: 1` for
correctness. The controller can route each call to a different replica, and
those replicas cannot see one another's in-memory state. Record this as a
constraint in the configuration review and handoff, not as a sizing preference.

If that state is a store or checkpointer that can instead be backed by a real
database (for example LangGraph's `AsyncPostgresStore`/`AsyncPostgresSaver`),
prefer declaring a `type: database` entry (see `manifest.md`) and pointing the
source's store/checkpointer at it instead of constructing an in-memory one.
The state then lives outside the process, so the `replicas: 1` constraint
above no longer applies.
