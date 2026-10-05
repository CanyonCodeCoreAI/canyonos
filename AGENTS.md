# AGENTS.md
This file provides guidance to AI coding agents when working with code in this repository.

## Repository map

A Bun + Turborepo workspace (TypeScript) and a uv workspace (Python) in one repo.

| Path | What it is | Language |
|---|---|---|
| `packages/core` | Runtime: controllers, LLM gateway, policy, telemetry (`canyonos_core`) | Python |
| `packages/cli` | The `canyonos` command line | Python |
| `packages/api` | Dashboard API | TypeScript (Bun) |
| `packages/web` | Dashboard frontend | TypeScript (React, Vite) |
| `packages/ui` | Shared React components for `web` | TypeScript (React) |
| `examples/` | Sample workflows to deploy with `canyonos deploy` | Python |
| `tests/` | Cross-package integration and performance tests | Python |

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
tests/run_tests.sh       # full integration and performance run
```

Run `bun run check` and `bun run test` before calling a change done.

## Rules

- Do not edit `uv.lock` or `bun.lock` by hand. Change dependencies with `uv add` / `bun add`; CI fails on a stale lockfile.
- Do not commit generated output: `.car/`, `stubs/`, `grpc_stubs/`, `build/`, `dist/`, `*.egg-info/`.
- Add or update tests next to the change: `packages/core/tests/`, `packages/cli/tests/`, `src/modules` in `api` and `web`, or `tests/` for cross-package behavior.
- Keep tool versions pinned exactly (e.g. `ruff==`, `ty==`, SHA-pinned GitHub Actions).
- Core modules are also imported as flat modules inside container images. Do not "fix" those fallback imports or the `E402` ignore in `pyproject.toml`.

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

- [skills/porting-to-canyonos](skills/porting-to-canyonos/SKILL.md): porting an existing Python agent to CanyonOS.
- [skills/prompt-management](skills/prompt-management/SKILL.md): extracting source prompts into versioned `prompts.yaml`.
- [skills/scaling-agents](skills/scaling-agents/SKILL.md): agent memory, `llms.yaml` model access and caps, and `scaling.yaml` policies.
