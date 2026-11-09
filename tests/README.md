# Cross-package tests

| Folder | What it proves | Runs |
|---|---|---|
| [`e2e/`](e2e/README.md) | Real projects deployed with the CLI and images from this checkout, checked through the CLI, the endpoint and the dashboard API. | `.github/workflows/e2e.yml`, on each pull request and by hand before a release |
| `cli_usage/` | The real `canyonos` CLI reporting usage to the real usage API on DynamoDB Local. | `.github/workflows/cli-usage-api-e2e.yml` |

The CLI's own subprocess tests live in `packages/cli/tests/e2e`. The API and
dashboard tests live in `packages/api` and `packages/web`.
