---
name: porting-to-canyonos
description: Port a Python agent project to CanyonOS by preparing and validating a `.car`.
---
# Port an agent project to CanyonOS

## Scope

- Edit only `.car`, `.gitignore` through `prepare.py`, and application-root
  `.env` / `.env.example`. Other changes require specific approval.
- Preserve application behavior, providers, dependency constraints and layout.
  Import existing logic; do not duplicate it or repair unrelated source defects.
- Read credential names from source or `.env.example`, never `.env`. Add missing
  names to `.env.example`; append only commented key reminders to `.env`.
- In unattended builds, use and report defaults. Stop with a blocker when a
  required choice has no safe default or needs approval.

## 1. Prepare

Choose the import root using [The `.car` artifact](https://raw.githubusercontent.com/CanyonCodeCoreAI/canyonos/main/docs/build-artifact.md)
and [Images and dependencies](https://raw.githubusercontent.com/CanyonCodeCoreAI/canyonos/main/docs/images-and-dependencies.md), then run:

```bash
python3 <skill_dir>/prepare.py <import-root> .car
```

Use `--refresh` for an existing copy. Use `--force` only when discarding all
port edits is authorized.

Trace the serving path in `.car/app`: inputs/outputs, imports, assets,
dependencies, state and async boundaries. Report required capabilities that
cannot run; missing credential values alone do not block preparation.

## 2. Choose services

Preserve the source framework's agent semantics: each agent defined by
LangChain or the framework in use maps to one service in its own container.
Keep the agent's internal execution intact; do not redefine its boundary by
looking for a model/tools loop. Expose its existing callable through the
service adapter.

Move orchestration between agents into the workflow, preserving the source
behavior. The workflow uses its own `llm_proxy` for model calls. If the source has no agent, wrap its existing entrypoint as one service.

Use `replicas: 1` for in-process state shared across requests. Preserve existing
external stores and concurrency controls; follow the
[adapter contract](https://raw.githubusercontent.com/CanyonCodeCoreAI/canyonos/main/docs/runtime-contract.md#adapter-shape).

## 3. Implement

- Write adapters and the workflow against the [Runtime contract](https://raw.githubusercontent.com/CanyonCodeCoreAI/canyonos/main/docs/runtime-contract.md).
  Put adapters beside the code they wrap; reuse compatible classes directly.
- Write one representative input from the source to `.car/config/test_query.txt`
  as raw query text, without labels or Markdown fences.
- Derive declarations, paths and requirements from the source. Write
  configuration using the [Manifest reference](https://raw.githubusercontent.com/CanyonCodeCoreAI/canyonos/main/docs/manifest-reference.md).
  Preserve existing choices; batch unresolved deployment questions and use
  schema defaults when unanswered or unattended. Leave `resources` at schema
  defaults without asking.
- Check each image's dependency set with `uv pip compile`, using the target
  Python version and [runtime requirements](https://raw.githubusercontent.com/CanyonCodeCoreAI/canyonos/main/docs/manifest-reference.md#per-image-requirements).
  Report incompatible constraints instead of changing application dependencies.
- Use `env_file: .env` unless another location was chosen. For local dashboard
  tracing, use the [OTel configuration](https://raw.githubusercontent.com/CanyonCodeCoreAI/canyonos/main/docs/manifest-reference.md#oteldestinations)
  unless disabled or another destination was chosen.
- For model calls, follow [LLM proxy](https://raw.githubusercontent.com/CanyonCodeCoreAI/canyonos/main/docs/llm-proxy.md).
- For EC2, follow [EC2 configuration](https://raw.githubusercontent.com/CanyonCodeCoreAI/canyonos/main/docs/ec2.md#configuration)
  using developer-supplied identifiers. If unavailable, leave `provider: local`
  and report that EC2 is not configured.

## 4. Validate and stop

Run `canyonos validate` from the application root. Resolve
[validation findings](https://raw.githubusercontent.com/CanyonCodeCoreAI/canyonos/main/docs/images-and-dependencies.md#what-canyonos-validate-checks)
until exit 0, or report the blocker. Check changes against the allowed scope.

`canyonos build` ends at static validation. Do not run `canyonos deploy` or
`canyonos test` during this flow.

Report the validation result, blockers, chosen defaults and required credential
names in the developer's language. Link to [Commands](https://canyonos.readthedocs.io/en/latest/#commands)
for next steps, including `canyonos test "$(cat .car/config/test_query.txt)"`.
Claim success only after validation exits 0 with no open blocker.
