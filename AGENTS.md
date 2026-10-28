# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

## Repository map

A Bun + Turborepo workspace (TypeScript) and a uv workspace (Python) in one repo.

| Path            | What it is                                                             | Language                 |
| --------------- | ---------------------------------------------------------------------- | ------------------------ |
| `packages/core` | Runtime: controllers, LLM gateway, policy, telemetry (`canyonos_core`) | Python                   |
| `packages/cli`  | The `canyonos` command line                                            | Python                   |
| `packages/api`  | Dashboard API                                                          | TypeScript (Bun)         |
| `packages/web`  | Dashboard frontend                                                     | TypeScript (React, Vite) |
| `packages/ui`   | Shared React components for `web`                                      | TypeScript (React)       |
| `examples/`     | Sample workflows to deploy with `canyonos deploy`                      | Python                   |
| `tests/`        | Cross-package integration and performance tests                        | Python                   |

How each part works is in [docs/architecture/](docs/architecture/README.md).

## Commands

```bash
uv sync                  # Python workspace (core + cli), editable
bun install              # TypeScript workspace

bun run check            # lint, type check, format check: what CI runs
bun run test             # every test suite: what CI runs
bun run format           # fix formatting (Ruff, Prettier)

uv run pytest packages/core/tests                    # one Python package
uv run pytest packages/cli/tests/test_clean.py       # one Python file
bun run --filter @canyonos/api test                  # one TypeScript package

bun run canyonos:dev     # shell with the CLI and images built from this checkout
uv run canyonos <cmd>    # run the checkout's CLI from anywhere in the workspace

bun run api:test:e2e     # API end-to-end tests
bun run ui:test:e2e      # dashboard Playwright tests
uv run pytest tests/ecosystem/cases --project=<name>   # ecosystem check of one real project
tests/run_tests.sh       # full integration and performance run
```

Run `bun run check` and `bun run test` before calling a change done.

## Rules

- Do not edit `uv.lock` or `bun.lock` by hand. Change dependencies with `uv add` / `bun add`; CI fails on a stale lockfile.
- Do not commit generated output: `.canyon/`, `stubs/`, `grpc_stubs/`, `build/`, `dist/`, `*.egg-info/`.
- Add or update tests next to the change: `packages/core/tests/`, `packages/cli/tests/`, `src/modules` in `api` and `web`, or `tests/` for cross-package behavior.
- Keep tool versions pinned exactly (e.g. `ruff==`, `ty==`, SHA-pinned GitHub Actions).
- Keep provider-specific logic (Local, EC2, and any new provider) inside `packages/core/canyonos_core/reconciler/providers/`. Callers go through `providers/__init__.py`, never a provider module or a provider name; see [its README](packages/core/canyonos_core/reconciler/providers/README.md).
- Keep Kubernetes-specific logic in core inside `packages/core/canyonos_core/kubernetes/`. The `kubernetes:` section is parsed with the other config sections in `schema/kubernetes_block.py`. Only three modules outside the package import from it: `controller/orchestrator.py` (`orchestrator_for` picks `KubernetesOrchestrator`), `cli.py` (registers `kubernetes/commands.py`) and `schema/kubernetes_block.py`. `tests/test_kubernetes_boundary.py` checks it; see [its `__init__.py`](packages/core/canyonos_core/kubernetes/__init__.py).
- A `canyonos` command that fails must exit non-zero, so a script or coding agent can tell. Its `run_*` function either returns `False` (or a non-zero code) and `cli.py` passes the result to `sys.exit`, or raises `RuntimeError`, which `cli.py` prints and exits 1. Never print an error and then `return` nothing.
- Naming: one word per thing, in code, comments, logs and docs.
  - _machine_: a computer, this one or a cloud VM. Never "instance" or "node".
  - _agent_: one entry under `agents:` in `global_controller.yaml`, databases and the endpoint included. Never "service". Its config is an _agent spec_: `agent_spec` for one, `agent_specs` for the list, `agent_specs_by_name` for the lookup.
  - _replica_: one running copy of an agent; an agent has N. Its ID is `<agent>-<8 random hex characters>`, e.g. `Alpha-1a2b3c4d`. Never "instance".
  - _container_: the Docker container itself (`container_name`, `container_port`, `docker` commands). Redis, the metrics collector and the Global Controller run in containers too, so not every container is a replica.
  - _orchestrator_: what starts, replaces and removes an agent's replicas; on Docker and EC2, CanyonOS's own reconciler; on Kubernetes, the operator and Kubernetes. The Global Controller decides how many replicas each agent should have and asks `gc.orchestrator` (`controller/orchestrator.py`) to run them. Never "replica manager" or "backend", and never call it "replicas", which are the running copies.
  - Names that predate this and stay: stored Redis keys such as `agent_instance:*` and `agent:<name>:instances`, exported telemetry names such as `agent.id` (it holds a replica ID), and AWS API names such as `run_instances` or `InstanceType`.
- Core modules are also imported as flat modules inside container images. Do not "fix" those fallback imports or the `E402` ignore in `pyproject.toml`.

## Reporting CanyonOS bugs

When you hit a bug in CanyonOS itself (the `canyonos` CLI, the runtime or the dashboard), ask your user whether to report it. Only if they agree, run:

```bash
canyonos feedback --yes "<what you ran, what you expected, what happened>"
```

- `--yes` stands for your user's agreement. Never pass it without asking.
- Leave out anything personal or secret: no paths, keys, prompts or code.
- Never change usage reporting (`canyonos contact`); that is your user's choice.

## Further reading

- Style and docstrings: [docs/contributing/STYLE.md](docs/contributing/STYLE.md)
- Local development: [docs/contributing/DEVELOPMENT.md](docs/contributing/DEVELOPMENT.md)
- Known limitations: [docs/guides/LIMITATIONS.md](docs/guides/LIMITATIONS.md)
- All docs: [docs/README.md](docs/README.md)

## Pull requests

Follow [CONTRIBUTING.md](CONTRIBUTING.md) (Conventional Commits, review gates), the
[PR template](.github/pull_request_template.md), and the
[AI policy](docs/contributing/AI_POLICY.md).

## Skills

- [skills/converting-to-canyonos](skills/converting-to-canyonos/SKILL.md): porting an existing Python agent to CanyonOS.
- [skills/prompt-management](skills/prompt-management/SKILL.md): extracting source prompts into versioned `prompts.yaml`.
- [skills/scaling-agents](skills/scaling-agents/SKILL.md): agent memory, `llms.yaml` model access and caps, and `scaling.yaml` policies.
- Engineering skills are canonical in `.agents/skills/`; `.claude/skills/` contains compatibility symlinks.
  Run `bun run skills:check` for offline validation. Read [evals/README.md](evals/README.md)
  before running the paid model evaluations.
