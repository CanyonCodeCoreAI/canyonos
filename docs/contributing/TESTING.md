# Testing

The checks and tests a pull request must pass, and how to run them from a checkout. Set
up the checkout first with [Development](DEVELOPMENT.md#set-up-your-environment).

## Checks

From the workspace root:

```bash
bun run check    # lint, type check, format check and license headers
bun run format   # fix what Ruff and Prettier can
```

| Files             | Tool                                                    | Rules                                                                           |
| ----------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Python            | Ruff (`pyproject.toml`)                                 | `ruff format`, with lines of 88 characters; lint rules `E4`, `E7`, `E9` and `F` |
| Python, Core only | ty (`pyproject.toml`)                                   | Type checks of `packages/core/canyonos_core`                                    |
| TypeScript        | Prettier (`.prettierrc.mjs`), oxlint (`.oxlintrc.json`) | Lines of 100 characters, single quotes, sorted imports; lint warnings fail      |
| Go                | `go fmt`, `go vet`, golangci-lint                       | Run by `make fmt vet lint` in `packages/operator`                               |
| Every source file | `reuse lint`                                            | The SPDX header; see [Style](STYLE.md#license-header)                           |

`bun run check` runs all of them but the Go checks; see [Operator](#operator).
`.editorconfig` sets UTF-8, LF line endings, a final newline and no trailing spaces for
every file.

## End-to-end tests

Apart from the operator's Go suites and a few CLI unit tests, the tests are end to end. Add or update the E2E
test at the boundary a change touches. The API and dashboard suites need the local env
files first:

```bash
cp .docker/.env.example .docker/.env
cp packages/api/.env.example packages/api/.env
cp packages/api/.env.test.example packages/api/.env.test
cp packages/web/.env.example packages/web/.env
```

| Suite                | Command                                                            | Needs                                                                                                                                                                                                |
| -------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API end-to-end       | `bun run api:test:e2e`                                             | Postgres (`bun run docker:up`); resets the `canyonos_test` database                                                                                                                                  |
| Dashboard end-to-end | `bun run ui:test:e2e`                                              | Chromium (`bunx playwright install chromium`); starts Postgres, the API and Vite, or reuses running ones                                                                                             |
| CLI end-to-end       | `bun run cli:test:e2e`                                             | Linux or macOS, and a Core image for the deploy case; see `packages/cli/tests/e2e/README.md`                                                                                                         |
| Deploy               | `uv run pytest tests/e2e/cases --project=helloworld`               | Docker; builds the images from this checkout, deploys the project and runs the E2E cases against it                                                                                                  |
| Deploy scenarios     | `uv run pytest tests/e2e/scenarios`                                | Docker; checks `canyonos validate`, the `new-app` starter, two projects on one dashboard, questions to a person, `stop` and `clean`, and the governance rules; the governance one needs the AWS keys |
| EC2 pool             | `tests/e2e/ec2_pool.sh`                                            | AWS access to run machines; manual, no workflow runs it                                                                                                                                              |
| Dashboard images     | `bun run canyonos:smoke`                                           | The images in `CANYONOS_API_IMAGE` and `CANYONOS_WEB_IMAGE` (default `canyonos-api:smoke`, `canyonos-web:smoke`)                                                                                     |
| CLI usage API        | `bun run cli:usage:test:e2e`, `bun run cli:usage:test:cli-e2e`     | Docker; each starts its own moto server                                                                                                                                                              |
| CLI unit             | `uv run pytest packages/cli/tests --ignore=packages/cli/tests/e2e` | Nothing else; no CI workflow runs them                                                                                                                                                               |
| Kubernetes           | `scripts/kind/e2e.sh`                                              | The kind cluster; see [Kubernetes](#kubernetes)                                                                                                                                                      |
| Operator             | `make manifests generate fmt vet test lint`                        | Go 1.26 or later, or the `golang:1.27.0` container; see [Operator](#operator)                                                                                                                        |

[`tests/e2e/README.md`](https://github.com/CanyonCodeCoreAI/canyonos/blob/main/tests/e2e/README.md)
lists the projects, their secrets and how to add a case.

## Kubernetes

```bash
scripts/kind/e2e.sh
```

`e2e.sh` tests the whole path, on the cluster from [Kubernetes on
kind](DEVELOPMENT.md#kubernetes-on-kind). CI runs it (`Kubernetes E2E`) on each pull
request, and on `main`, for changes to Core, the CLI, the API, the operator (the chart
included) or `scripts/kind`. It builds the images with `bun run canyonos:dev
--images-only`, installs them (`operator.sh`), and deploys `examples/helloworld` with
the real CLI as a user who may only edit one namespace. It then checks requests, the
dashboard, a Redis password rotation, `stop` and `clean`. Everything but the image
builds runs in a container on the kind network, so it runs the same on any OS.

## Operator

Run the operator's envtest suites in `packages/operator`, with Go 1.26 or later, or in
the `golang:1.27.0` container CI uses:

```bash
make manifests generate fmt vet test lint
```

CI (`.github/workflows/operator.yml`) runs the same, and fails when the generated
files (deep-copy code, CRDs and RBAC) were not committed.

## Docs

The docs are built with MkDocs from `docs/`, as configured in `mkdocs.yml`, with the
versions pinned in `docs/requirements.txt`. Read the Docs fails the build on any
warning, so build with `--strict` before a docs change:

```bash
uv run --no-project --with-requirements docs/requirements.txt mkdocs build --strict
uv run --no-project --with-requirements docs/requirements.txt mkdocs serve
```

`mkdocs serve` shows the site on `http://127.0.0.1:8000` and rebuilds it on each save.
For how to write them, see [Style](STYLE.md#docs).
