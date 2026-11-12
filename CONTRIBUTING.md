# Contributing to CanyonOS

Thanks for helping out! This page covers how to send a change.
[Development](docs/contributing/DEVELOPMENT.md) sets up a checkout,
[Testing](docs/contributing/TESTING.md) runs the checks and tests, and
[Style](docs/contributing/STYLE.md) has the rules for code and docs.

Issues for newcomers are labeled `good first issue`; issues open to outside help are labeled `help wanted`. PRs for other issues may be closed.

## Repository layout

| Path                     | What it is                                                                       | Language                 |
| ------------------------ | -------------------------------------------------------------------------------- | ------------------------ |
| `packages/core`          | Runtime: controllers, LLM Gateway, policy, telemetry (`canyonos_core`)           | Python                   |
| `packages/cli`           | The `canyonos` command line                                                      | Python                   |
| `packages/api`           | Dashboard API                                                                    | TypeScript (Bun)         |
| `packages/web`           | Dashboard frontend                                                               | TypeScript (React, Vite) |
| `packages/ui`            | Shared React components for `web`                                                | TypeScript (React)       |
| `packages/operator`      | Kubernetes operator and its Helm chart                                           | Go                       |
| `packages/cli-usage-api` | The API that receives the CLI's usage reports and `canyonos feedback`            | TypeScript (Bun)         |
| `packages/tsconfig`      | Shared TypeScript settings                                                       | JSON                     |
| `skills/`                | Skills for coding agents; `canyonos convert` installs `converting-to-canyonos`   | Markdown, Python         |
| `examples/`              | Sample workflows to deploy with `canyonos deploy`                                | Python                   |
| `tests/`                 | End-to-end tests across packages                                                 | Python                   |
| `scripts/`               | The dev shell, the kind cluster and release tooling                              | TypeScript, shell        |
| `evals/`                 | Promptfoo evaluations of the skills                                              | JavaScript               |
| `docs/`                  | This documentation, built with MkDocs                                            | Markdown                 |

## Setup

You need [uv](https://docs.astral.sh/uv/) (>= 0.12.15), [Bun](https://bun.sh/) (>= 1.3.1)
and Docker, and Go to work on the operator.
[Development](docs/contributing/DEVELOPMENT.md#set-up-your-environment) clones your fork
and sets up the checkout.

## Making a change

1. Fork the repo on GitHub, and create a branch in your fork from `main`.
2. Make your change and add or update an E2E test at the boundary it changes.
3. Run the same checks CI runs: `bun run check` for Python and TypeScript (lint, type
   check, format check and license headers; `bun run format` fixes the formatting), and
   `make manifests generate fmt vet test lint` in `packages/operator` for the operator.
   [Testing](docs/contributing/TESTING.md) lists every check and test suite.
4. Commit with a [Conventional Commits](https://www.conventionalcommits.org/) message:
   `fix(core): ...`, `feat(cli): ...`, `docs: ...`. Fill in the
   [PR template](https://github.com/CanyonCodeCoreAI/canyonos/blob/main/.github/pull_request_template.md); this format helps moderators review your PR.
5. Open a pull request against `main`; we will try to review the code within a week!

## Review and quality gates

A pull request can merge once all of these pass:

- **Review**: at least one approving review from a maintainer.
- **CI**: the checks in step 3, as `CI / test`, `CLI on …` and, for the operator,
  `Operator / test`.
- **Build**: the container images still build (`CanyonOS images`, `Core image`).
- **E2E**: the deploy suites need model and AWS keys, so they skip on a pull request
  from a fork. Run them locally (see [Testing](docs/contributing/TESTING.md)); a
  maintainer runs them before merging.
- **Code scanning**: no new CodeQL or Semgrep alerts at the blocking severity.

Maintainers merge approved pull requests. Keep pull requests small and focused;
they get reviewed faster.

## Reporting issues

Open a [GitHub issue](https://github.com/CanyonCodeCoreAI/canyonos/issues) with
what you ran, what you expected and what happened. Report security vulnerabilities
privately, as described in [SECURITY.md](https://github.com/CanyonCodeCoreAI/canyonos/blob/main/SECURITY.md).

## AI policy

You may use AI tools to write code. You stay responsible for what you send, as we are
for what we merge and release.

- **Understand every part your pull request touches:** the controllers, agents, CLI
  commands, config and manifest fields, APIs, and anything else whose behavior changes.
  Be ready to explain what each does today, how your change affects it, and what
  depends on it. We close pull requests whose author can't.
- **Write to maintainers yourself.** Describe issues, pull requests and your answers to
  questions in your own words; don't paste AI replies. We may hide comments we believe
  are AI-generated.
- **Mark AI output as such.** To share context from an AI conversation, quote a short
  excerpt in a block (`>`), say it comes from AI, and add why it matters.
- **Write the docs in `docs/` by hand,** apart from AI-generated charts and diagrams in
  `docs/architecture`.
- **AI help with English is fine,** as long as the comment keeps your ideas and voice.
  To translate, write in your own language and add the AI translation in a quote block.

## License

By contributing, you agree that your contributions are licensed under the
[GNU AGPL v3.0](https://github.com/CanyonCodeCoreAI/canyonos/blob/main/LICENSE).

CanyonOS is developed with commercial intent. By contributing, you also agree that
Canyon Code may use your contributions in its commercial products and services.

If you contribute as part of your job, your employer likely owns your work. Before
contributing, get your employer's permission to do so. By contributing, you confirm
that you have this permission and that ownership of your contributions transfers to
Canyon Code.
