# Monitoring query layer

Read-only queries behind the project monitoring screens. Nothing here ingests, writes or alerts —
the OTLP receiver (`modules/telemetry`) fills `otel_spans`, `otel_logs` and `otel_metrics`, and this
module only reads them back.

## Endpoints

All are `GET`, all sit under `/projects/:project_id/monitoring`, and all take `time_window` — one of
`1d`, `7d`, `30d`, `1q`, defaulting to `1d`.

| Path              | Answers                                          | Extra query params                         |
| ----------------- | ------------------------------------------------ | ------------------------------------------ |
| `/series`         | the four golden signals on one shared time grid  | —                                          |
| `/logs`           | newest-first log records                         | `limit`, `errors_only`, `agent`, `replica` |
| `/logs/sources`   | the agents and replicas that wrote in the window | —                                          |
| `/llm`            | spans carrying a model call, newest first        | `limit`                                    |
| `/traces`         | traces with their spans, newest first            | `limit`                                    |
| `/errors/summary` | error counts by exception type and by agent      | —                                          |
| `/resources`      | cpu/memory/disk/gpu per machine and per agent    | —                                          |

The routes are prefix-less and composed into `projects.routes`, so the whole `/projects` tree stays
one Eden type. Auth and project access resolve before every handler.

## Files

```
monitoring.types.ts     the contract, as zod schemas — the only file the web app imports
monitoring.signals.ts   what each signal is: source, unit, flow or stock
monitoring.service.ts   thin; attaches project_id and time_window to what the store returns
monitoring.routes.ts    the seven endpoints above
db/store.ts             the MonitoringStore interface every backend implements
db/postgres.ts          the implementation in use
db/index.ts             picks the store the service reads through
```

## Consuming it

The web app imports the contract types from the `@canyonos/api/monitoring` SDK subpath, which
re-exports `monitoring.types.ts` via `src/sdk/monitoring.ts`. Response shapes are validated against
those same schemas by Elysia on the way out, so a store that returns the wrong shape fails the
request rather than reaching the browser.

## Changing it

- **A new field on a response** — the zod schema and, for `resource_utilization` and
  `error_summary`, the `json_build_object` in `db/postgres.ts` that builds the object. Both.
- **A new signal** — an entry in `monitoring.signals.ts` plus its SQL in the store. The definitions
  describe signals; they do not yet generate queries.
- **A new backend** — a file beside `db/postgres.ts` implementing `MonitoringStore`, and one changed
  line in `db/index.ts`.

`ARCHITECTURE.md` in this folder explains the flow and the invariants.
