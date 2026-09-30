# Contributing to CanyonOS

### Thanks for helping out!

Issues for newcomers are labeled `good first issue`; issues open to outside help are labeled `Help Wanted`. PRs for other issues may be closed. Issues and PRs are also labeled `Python` and/or `Javascript`, based on the expertise needed to complete/review them.

## Repository layout

| Path | What it is | Language |
|---|---|---|
| `packages/core` | Runtime: controllers, LLM gateway, policy, telemetry (`canyonos_core`) | Python |
| `packages/cli` | The `canyonos` command line | Python |
| `packages/api` | Dashboard API | TypeScript (Bun) |
| `packages/web` | Dashboard frontend | TypeScript (React, Vite) |
| `packages/ui` | Shared React components for `web` | TypeScript (React) |
| `examples/` | Sample workflows to deploy with `canyonos deploy` | Python |
| `tests/` | Cross-package integration and performance tests | Python |

## Setup

You need [uv](https://docs.astral.sh/uv/) (>= 0.12.15), [Bun](https://bun.sh/) (>= 1.3.1) and Docker.

```bash
git clone https://github.com/CanyonCodeCoreAI/canyonos.git
cd canyonos
uv sync        # Python workspace (core + cli), installed editable
bun install    # TypeScript workspace
```

To run the CLI, Core and dashboard from this checkout, see [DEVELOPMENT.md](docs/contributing/DEVELOPMENT.md).

## Making a change

1. Fork the repo (or create a branch if you have write access) from `main`.
2. Make your change and add or update tests next to it, e.g. `packages/core/tests/`.
3. Run the same checks CI runs:

   ```bash
   bun run check   # lint, type check, format check (Ruff, ty, oxlint, Prettier)
   bun run test    # all test suites
   ```

   To fix formatting: `bun run format`. To run one package's tests: `uv run pytest packages/core/tests`.
4. Commit with a [Conventional Commits](https://www.conventionalcommits.org/) message:
   `fix(core): ...`, `feat(cli): ...`, `docs: ...`. Fill in the
   [PR template](.github/pull_request_template.md); this format helps moderators review your PR.
5. Open a pull request against `main`, we will try to review the code within a week!

## Review and quality gates

A pull request can merge once all of these pass:

- **Review**: at least one approving review from a maintainer.
- **CI** (`test`): the same checks as step 3.
- **Build** (`build`): the container images still build.
- **Code scanning**: no new CodeQL or Semgrep alerts at the blocking severity.

Maintainers merge approved pull requests. Keep pull requests small and focused;
they get reviewed faster.

## Reporting issues

Open a [GitHub issue](https://github.com/CanyonCodeCoreAI/canyonos/issues) with
what you ran, what you expected and what happened. Report security vulnerabilities
privately, as described in [SECURITY.md](SECURITY.md).

## AI Usage

AI usage is allowed on our project, as long as it follows our [AI Policy](docs/contributing/AI_POLICY.md).

## License

By contributing, you agree that your contributions are licensed under the
[GNU AGPL v3.0](LICENSE).
