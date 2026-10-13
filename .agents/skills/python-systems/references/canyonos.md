# CanyonOS Python reference

Read this only for CanyonOS Python changes. Read the matching document in
`docs/architecture/` before designing the changed area.

## Runtime constraints

- Python 3.10 uses synchronous code. Concurrency is `threading` and
  `concurrent.futures.ThreadPoolExecutor`; child processes use `subprocess`.
  Do not introduce asyncio.
- Controllers communicate through gRPC in `controller/proto/`; the LLM Gateway
  is Flask. Redis is shared state and telemetry uses OpenTelemetry.
- The CLI is argparse plus Rich. Add dependencies with `uv add`, never by hand.

## Existing owners

| Need                                  | Owner                                                           |
| ------------------------------------- | --------------------------------------------------------------- |
| Redis access                          | `RedisClient` in `controller/utils/redis_client.py`             |
| Child-process lifecycle               | `ProcessSupervisor` in `controller/utils/process_supervisor.py` |
| `.env` loading and `${VAR}` expansion | `controller/utils/config_env.py`                                |
| User-config validation                | `canyonos_core/schema/`                                         |
| Container names                       | `controller/utils/container_names.py`                           |
| CLI output                            | `canyonos/ui.py` (`say`, `ok`, `fail`, `warn`, `hint`)          |
| Redis in tests                        | `_FakeRedis` in `packages/core/tests/fakes.py`                  |

The Local Controller is the per-replica request fast path: run or forward the
request and report its result. Keep decisions, bookkeeping, aggregation, and
cleanup in the Global Controller or Reconciler. Do not add request-path Redis
round trips, file reads, or config parsing; use a background refresh when the
runtime needs refreshed configuration.

Futures and dispatch go through `LocalController`. Do not add a parallel
dispatch path, identifier scheme, or Redis read-back for the same work.

## Repository constraints

- Core modules are imported as flat modules inside container images. Preserve
  the paired package/flat imports and intentional `E402` handling.
- Add new flat module names to `allowed-unresolved-imports` in root
  `pyproject.toml` so `ty` can resolve them.
- gRPC output is generated. Edit `.proto` sources, not `*_pb2*.py`; never commit
  `stubs/` or `grpc_stubs/`.
- Put provider-specific code (Local, EC2, or a new provider) only in that
  provider's folder under `reconciler/providers/`. Everywhere else, call
  providers through the interface in `reconciler/providers/__init__.py`
  (`providers.get(name)` and the functions every provider defines). Never import
  a provider's module directly or check a provider's name. `ProviderBoundaryTests`
  in `packages/core/tests/test_providers.py` fails if core code breaks this.
- Add shipped non-Python files through package-data.
- New background threads need a name. Failed loop iterations must be logged and
  the loop must continue when recovery is safe.

## CLI and verification

`packages/cli/cli.py` parses arguments and calls `run_<cmd>` in
`canyonos/<cmd>.py`; register help text in `utils/help_screen.py`. Use
`canyonos.ui`, never bare `print`.

```bash
uv run pytest packages/core/tests/test_<area>.py
uv run pytest packages/cli/tests
bun run check
tests/e2e/run.sh # portfolio deployment and real query; requires AWS credentials
```

For controller, gateway, or Reconciler work, deploy `examples/portfolio`, query
with `canyonos test`, and inspect the logs when the required environment exists.
