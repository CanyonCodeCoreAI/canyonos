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

This isolation does not cover deployment's fixed Docker names, ports, networks,
volumes, or the shared daemon. This foundation does not start, stop, or reuse an
existing workflow. Full deploy tests need a dedicated runtime owner. Correctness
tests should keep query concurrency low; load tests belong in the separate
performance suite.
