---
name: converting-to-canyonos
description: Port a Python agent project to CanyonOS by preparing and validating a `.canyon`. Also use to deploy, inspect, or change a running CanyonOS project from the `canyonos` command line.
---
# Port an agent project to CanyonOS

## Scope

- Edit only `.canyon`, and `.gitignore` through `prepare.py`. Other changes
  require specific approval.
- Preserve application behavior, providers, dependency constraints and layout.
  Import existing logic; do not duplicate it or repair unrelated source defects.
- `.env` stays in the project folder, and `canyonos deploy` passes it to the
  agent replicas. Never read it or copy it; `prepare.py` leaves it out of
  `.canyon`. Add any credential names the code needs to `.canyon/.env.example`.
- In unattended builds, use and report defaults. Stop with a blocker when a
  required choice has no safe default or needs approval.

## 1. Prepare

Choose the import root using [Project layout](https://raw.githubusercontent.com/CanyonCodeCoreAI/canyonos/main/docs/guides/BUILD_ARTIFACT.md)
and [Images and dependencies](https://raw.githubusercontent.com/CanyonCodeCoreAI/canyonos/main/docs/guides/IMAGES_AND_DEPENDENCIES.md), then run:

```bash
python3 <skill_dir>/prepare.py <import-root> .canyon
```

Use `--refresh` for an existing copy. Use `--force` only when discarding all
port edits is authorized.

`prepare.py` refuses an import root whose top level has a `config/`, `stubs/`,
`grpc_stubs/` or `docker_container/` folder, since CanyonOS writes those. Renaming
source is outside this skill's scope: report it as a blocker unless the developer
approves the rename.

Trace the serving path in `.canyon`: inputs/outputs, imports, assets,
dependencies, state and async boundaries. Report required capabilities that
cannot run; missing credential values alone do not block preparation.

## 2. Choose agents

Preserve the source framework's agent semantics: each agent defined by
LangChain or the framework in use maps to one CanyonOS agent in its own container.
Keep the agent's internal execution intact; do not redefine its boundary by
looking for a model/tools loop. Expose its existing callable through the
agent adapter.

Move orchestration between agents into the agent the endpoint serves,
preserving the source behavior. That agent uses its own `llm_gateway` for model
calls. If the source has no agent, wrap its existing entrypoint as one agent
and serve it.

Use `replicas: 1` for in-process state shared across requests. Preserve existing
external stores and concurrency controls; follow the
[adapter contract](https://raw.githubusercontent.com/CanyonCodeCoreAI/canyonos/main/docs/guides/RUNTIME_CONTRACT.md#adapter-shape).

## 3. Implement

- Write adapters and the agent the endpoint serves against the [Runtime contract](https://raw.githubusercontent.com/CanyonCodeCoreAI/canyonos/main/docs/guides/RUNTIME_CONTRACT.md).
  Put adapters beside the code they wrap; reuse compatible classes directly.
- Write one representative input from the source to `.canyon/config/test_query.txt`
  as raw query text, without labels or Markdown fences.
- Derive each agent's `functions` (the methods other agents or the endpoint
  call, with argument and return types built from builtins), paths and
  requirements from the source. Write configuration using the
  [Manifest reference](https://raw.githubusercontent.com/CanyonCodeCoreAI/canyonos/main/docs/guides/GLOBAL_CONTROLLER.md).
- Declare the top-level `endpoint: {agent, method}` block naming the agent the
  endpoint serves and its entry method. That method must be listed in the
  agent's `functions`, with the arguments the request body carries.
  Preserve existing choices; batch unresolved deployment questions and use
  schema defaults when unanswered or unattended. Leave `resources` at schema
  defaults without asking.
- Check each image's dependency set with `uv pip compile`, using the target
  Python version and [runtime requirements](https://raw.githubusercontent.com/CanyonCodeCoreAI/canyonos/main/docs/guides/GLOBAL_CONTROLLER.md#per-image-requirements).
  Report incompatible constraints instead of changing application dependencies.
- For local dashboard tracing, use the [OTel configuration](https://raw.githubusercontent.com/CanyonCodeCoreAI/canyonos/main/docs/guides/GLOBAL_CONTROLLER.md#oteldestinations)
  unless disabled or another destination was chosen.
- For model calls, follow [LLM gateway](https://raw.githubusercontent.com/CanyonCodeCoreAI/canyonos/main/docs/guides/LLM_GATEWAY.md).
- For EC2, follow [EC2 configuration](https://raw.githubusercontent.com/CanyonCodeCoreAI/canyonos/main/docs/guides/EC2.md#configuration)
  using developer-supplied identifiers. If unavailable, leave the top-level
  `provider: local` and report that EC2 is not configured.

## 4. Validate and stop

Run `canyonos validate` from the application root. Resolve
[validation findings](https://raw.githubusercontent.com/CanyonCodeCoreAI/canyonos/main/docs/guides/IMAGES_AND_DEPENDENCIES.md#what-canyonos-validate-checks)
until exit 0, or report the blocker. Check changes against the allowed scope.

`canyonos convert` ends at static validation. Do not run `canyonos deploy` or
`canyonos test` during this flow.

Report the validation result, blockers, chosen defaults and required credential
names in the developer's language. Link to [Commands](https://canyonos.readthedocs.io/en/latest/#commands)
for next steps, including `canyonos test "$(cat .canyon/config/test_query.txt)"`.
Claim success only after validation exits 0 with no open blocker.

## After the conversion: run the deploy

Only once the conversion is reported and you are asked to run it. From the
project folder, with no terminal attached:

- `canyonos deploy --serve false`: build and start it without the dashboard, using
  default resources instead of asking. It replaces this project's earlier deploy.
- `canyonos status --json`: `running`, `endpoint`, `dashboard_url`, per agent the
  desired and running replicas and last launch error, each machine type's last
  start error, and `errors` for any part it could not read. Exits 1 if nothing runs.
- `canyonos test --json "$(cat .canyon/config/test_query.txt)"`: send one query.
- `canyonos logs --no-follow`: print the last 200 log lines and exit.
- `canyonos logs <agent>`: print the last 200 lines of each of that agent's replicas,
  or of one replica such as `IntentAgent-1`; `--tail N` or `--tail all` for more.
- Any change, config or code, takes effect only after another `canyonos deploy`.
- `canyonos validate --json`: recheck `.canyon` after an edit.
- `canyonos stop` removes the deploy; `canyonos clean` also removes `.canyon` and the images.

Every command exits non-zero on failure.

## Reporting a CanyonOS bug

When a `canyonos` command fails because of CanyonOS itself, not the project, ask
your user whether to report it. Only if they agree, run
`canyonos feedback --yes "<what you ran, what you expected, what happened>"`.
`--yes` stands for their agreement; never pass it without asking. Leave out
paths, keys, prompts and code. Never change usage reporting with `canyonos contact`.
