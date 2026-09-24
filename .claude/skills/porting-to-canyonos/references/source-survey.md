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

**Output:** one service per agent, including which edges of the source
workflow cross services and which services require `replicas: 1`.

### What counts as an agent

An agent is a unit that the original workflow being ported invokes as a whole,
whose output depends on a model call. Split each agent into its own service.
Class and node names are not evidence: a class called `ChiefEditorAgent` that
builds and runs a graph is an orchestrator, and a `PublisherAgent` that only
formats and writes files is a plain step.

Decide each candidate in this order; the first match wins.

1. **Not invoked as a unit by the source workflow** — a helper, tool, prompt
   builder, or parser that a node calls. Not an agent; it stays inside the
   agent that calls it. Tools are never agents.
2. **Builds or runs other units** — constructs a `StateGraph`, calls
   `compile().invoke/ainvoke`, fans out with `Send` or `asyncio.gather`
   over invocations. An orchestrator: its logic becomes the workflow.
3. **Output does not depend on a model call** — an edge router (`route_*`,
   `should_continue`) or a pure transform (formatting, publishing, file I/O).
   Not an agent; the workflow imports and calls it from the source unchanged.
4. **Needs a human or device during the request** — `input()`, a websocket
   receive, `interrupt()` waiting on a person. A readiness blocker, not a
   service; see the application-readiness gate above.
5. **Otherwise it is an agent.**

Group agents into services by the object the source workflow calls:

- Nodes bound to methods of one instance are one agent: one service, one
  declared method per node.
- A prebuilt or ReAct agent (`create_react_agent`, `create_agent`,
  `AgentExecutor`) is one agent, including its internal agent/tools loop.
  Do not split its tools node.
- A module-level function node that calls a model is one agent by itself.
- A model that chooses the next unit (a supervisor, an LLM router) is an
  agent whose output is that choice; the workflow executes the handoff.
- A plain LangChain chain (`prompt | llm | parser`) is an agent only when it
  is itself a graph node; otherwise it belongs to the agent that invokes it.

### Edges between agents

Every edge between two agents crosses a service boundary, so the workflow
re-expresses it as ordinary Python. Import the connected source node functions
and routers unchanged. If the graph holds a single agent, preserve
`graph.compile().invoke(...)` and wrap it.

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
