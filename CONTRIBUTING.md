# Contributing to CanyonOS

Thanks for helping out. Bug reports, fixes, docs and features are all welcome.

## Repository layout

| Path | What it is | Language |
|---|---|---|
| `packages/core` | Runtime: controllers, LLM proxy, telemetry, `.car` validation | Python |
| `packages/cli` | The `canyonos` command | Python |
| `packages/api` | Dashboard API | TypeScript (Bun) |
| `packages/web`, `packages/ui` | Dashboard frontend | TypeScript (React) |
| `examples/` | Sample workflows | Python |

## Setup

You need [uv](https://docs.astral.sh/uv/) (>= 0.12.15), [Bun](https://bun.sh/) (>= 1.3.1) and Docker.

```bash
git clone https://github.com/CanyonCodeCoreAI/canyonos.git
cd canyonos
uv sync        # Python workspace (core + cli), installed editable
bun install    # TypeScript workspace
```

For CLI development details, see [packages/cli/DEVELOPMENT.md](packages/cli/DEVELOPMENT.md).

## Making a change

1. Fork the repo (or create a branch if you have write access) from `main`.
2. Make your change and add or update tests next to it, e.g. `packages/core/tests/`.
3. Run the same checks CI runs:

   ```bash
   bun run check   # lint, type check, format check (Ruff, ty, oxlint, Prettier)
   bun run test    # all test suites
   ```

   While iterating on core, run just its tests:

   ```bash
   uv run pytest packages/core/tests
   ```

   To fix formatting: `bun run format`.
4. Commit with a [Conventional Commits](https://www.conventionalcommits.org/) message:
   `fix(core): ...`, `feat(cli): ...`, `docs: ...`.
5. Open a pull request against `main`, describing what changed and how you tested it.

## Review and quality gates

A pull request can merge once all of these pass:

- **Review**: at least one approving review from a maintainer.
- **CI** (`test`): lint, type check, format check and tests for every package.
- **Build** (`build`): the container images still build.
- **Code scanning**: no new CodeQL or Semgrep alerts at the blocking severity.

Maintainers merge approved pull requests. Keep pull requests small and focused;
they get reviewed faster.

## Reporting issues

Open a [GitHub issue](https://github.com/CanyonCodeCoreAI/canyonos/issues) with
what you ran, what you expected and what happened. Please report security
vulnerabilities privately to the maintainers instead of in a public issue.

## License

By contributing, you agree that your contributions are licensed under the
[GNU AGPL v3.0](LICENSE).
