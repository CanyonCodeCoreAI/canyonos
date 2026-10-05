---
name: scaling-agents
description: Configure how a CanyonOS project's agents hold state, use models, and scale. Use when setting up or reviewing agent memory, `llms.yaml` model access and cost caps, or `scaling.yaml` autoscaling policies.
---

# Configure memory, models and scaling for CanyonOS

Decide where each agent keeps state, which models it may call, and how many
replicas it may run, from the project's actual source. Work in this order:
replicas depend on state, and spend depends on replicas. Preserve application
behavior; do not invent limits that refuse real calls.

## 1. Locate the source and config

- Find the active `global_controller.yaml`. Write `llms.yaml` and `scaling.yaml`
  beside it: `.car/config/` for a ported project, or `config/` for the source
  layout. Respect an explicitly chosen destination.
- Trace each manifest entry's entrypoint and the workflow. For a `.car` project,
  inspect `.car/app`, since that is the deployed source.
- Read existing `llms.yaml` and `scaling.yaml` first. Keep their entries, names
  and other fields; change only what the source contradicts or the developer asked.

## 2. Memory

Follow the [Runtime contract](https://raw.githubusercontent.com/CanyonCodeCoreAI/canyonos/main/docs/guides/RUNTIME_CONTRACT.md)
and [database entries](https://raw.githubusercontent.com/CanyonCodeCoreAI/canyonos/main/docs/guides/GLOBAL_CONTROLLER.md).

- For each agent, find state that outlives one call: attributes on `self`,
  module globals, caches, conversation history, and framework stores such as
  LangGraph `InMemoryStore` or `MemorySaver`. Read-only data loaded at startup is
  not state.
- State shared within one request only: set `stateful: true`. Replicas route a
  request's calls to one copy, so the agent can still scale.
- State shared across requests in process: keep `replicas: 1` and
  `stateful: true`, and mark the agent unscalable. Another replica would not see it.
- State already in an external store, or in a database entry resolved through
  `routing_table:endpoints`: keep it; the agent is scalable.
- Moving in-process state to a database entry changes application code. Propose
  it with the store and entry it needs; implement it only when approved.
- All calls share one instance on eight threads. Report unsynchronized mutable
  state on `self` as a defect instead of fixing it.

## 3. Models: `llms.yaml`

Follow [LLM gateway](https://raw.githubusercontent.com/CanyonCodeCoreAI/canyonos/main/docs/guides/LLM_GATEWAY.md).

- For each OpenAI, Anthropic and Bedrock call, record the calling manifest entry,
  the deployed `model_id`, and any output-token limit the call sets. Resolve a
  model ID read from the environment through `.env.example` and its source
  default; if it cannot be resolved, report it and write no entry for it.
- Write one entry per model, named after the model. List **every** agent that
  calls it. An agent missing from an `agents` list is refused with a 403, so an
  incomplete list breaks the app. If any caller is uncertain, write no entry.
- Never give a model the workflow calls an `agents` list: the workflow container
  has no agent name, so the gateway refuses all of its calls to that model.
- Leave every cap empty unless the developer supplies a dollar amount. A cap is
  checked against the worst case, input bytes / 4 plus the full output limit, so a
  guessed cap refuses calls that would have been cheap.
- An entry with a cap needs a numeric `max_tokens` and a price for the model in
  `packages/core/canyonos_core/llm_gateway/llm_prices.json`. Otherwise the
  gateway rejects the whole file and refuses every call. Set `max_tokens` to the
  largest limit the calls set.
- Write no `llms.yaml` when the project calls no model through the gateway.

## 4. Scaling: `scaling.yaml`

Follow [Autoscaling](https://raw.githubusercontent.com/CanyonCodeCoreAI/canyonos/main/docs/guides/SCALING.md).

- Write policies only for `type: agent` entries that step 2 found scalable.
  Never scale the workflow or a database entry.
- `min_replicas` is the entry's current `replicas`. Use
  `requests_per_minute_per_replica` for request-bound agents and
  `queue_length_total` for agents whose calls queue behind slow work.
- Without developer values, use the guide's example numbers
  (`max_replicas: 6`, `scale_up_above: 10`, `scale_down_below: 1`) and report
  them as defaults. Do not scale an aggregation barrier or an agent whose
  downstream dependency cannot take more load; report why it was left out.
- Each policy needs integer replicas of at least 1 with `min <= max`, numbers of
  at least 0, and `scale_down_below < scale_up_above`. An invalid policy is
  skipped with only a controller warning.

## 5. Verify and report

- Parse both files. Check every rule in steps 3 and 4, and that every agent
  named in either file is an entry in `global_controller.yaml`; a misspelled name
  is refused in `llms.yaml` and ignored in `scaling.yaml`.
- Run `canyonos validate` from the application root and resolve findings until
  exit 0, or report the blocker.
- Report per agent: its state and whether it scales, the models it calls and
  caps, its policy, and which values are defaults. List call paths whose model
  could not be resolved and code changes proposed but not made.

The Global Controller publishes both files on startup and reload. Gateways
read `llms.yaml` within 5 seconds and refuse every call until the first read.
Dashboard scaling edits are not written back and are lost on reload; copy edits
that must survive into `scaling.yaml`.
