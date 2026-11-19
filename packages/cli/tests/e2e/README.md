# CLI E2E Tests

This suite runs the installed `canyonos` console script in isolated subprocesses.
From the workspace root:

```bash
bun run cli:test:e2e
```

The underlying command is:

```bash
uv run --frozen --package canyonos pytest packages/cli/tests/e2e
```

Tests run serially. Each case owns its `HOME`, working directory, environment,
temporary state, process groups, and logs. Every command's output and every
service log go to `artifacts/` under pytest's base temp directory, which pytest
prunes to the last three runs. CI sets that directory with `--basetemp` and
uploads `artifacts/` when the job fails.

This isolation does not cover workflow group's fixed Docker names, ports, networks,
volumes, or the shared daemon. The runtime cases (`test_quickstart.py`,
`test_api_lifecycle.py`, `test_deploy_checks.py`) deploy for real with the images in
`CANYONOS_CORE_IMAGE` and `CANYONOS_API_IMAGE`, through the helpers in `harness.py`,
and skip without a Docker engine and a Core image; each stops what it started.
Correctness tests should keep query concurrency low; load tests belong in the separate
performance suite.
