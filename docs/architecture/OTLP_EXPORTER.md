# OTLP exporter

The OTLP exporter sends CanyonOS traces, metrics and logs to the OpenTelemetry
destinations in `otel.destinations`, the dashboard API among them. The Global Controller
copies telemetry from Redis into a SQLite queue, and the exporter, a separate process,
delivers the queue on its own loop. A slow or failing destination never blocks a
request, and destinations are reread from Redis on every poll, so a config change needs
no restart. How to configure destinations is in the user guide:
[`otel.destinations`](../guides/WORKFLOW_CONFIG.md#oteldestinations).

| Path (under `packages/core/canyonos_core/`) | What it holds                                                  |
| ------------------------------------------- | -------------------------------------------------------------- |
| `controller/utils/schema.py`                | `DB_PATH`, the three queue tables, `init_db`                   |
| `controller/utils/otel_writer.py`           | Producer side: `send_telemetry`, `metric_write_rows`, upserts  |
| `otlp_exporter/otel_exporter.py`            | The exporter process: destinations, export loop, retention     |
| `otlp_exporter/otel_reader.py`              | Consumer side: mark sent, flush, delete expired                |
| `otlp_exporter/trace_convert.py`            | Queue row to OTel span                                         |
| `otlp_exporter/metric_convert.py`           | Queue row to OTel `ResourceMetrics`                            |
| `otlp_exporter/log_convert.py`              | Queue row to OTel log records                                  |
| `schema/otel_destinations.py`               | Destination rules shared by the config schema and the exporter |

The producer and the consumer share nothing but `schema.py` and the database file.

## Where it runs

The exporter runs as a supervised subprocess in the Global Controller's container, on
every target.

```text
each machine's Redis: future:*, controller:*:metrics, machine:*:metrics
 │ HGETALL
 ▼
Global Controller container
 ├─ GlobalController: _poll_one_replica, _send_telemetry_per_host,
 │  poll_machine_metrics, deliver_completed_requests, ProcessLogHandler
 │   ├─ upserts rows ─► SQLite queue (otel_queue.db)
 │   ├─ SET otel:destinations ─► the primary Redis
 │   └─ ProcessSupervisor starts and restarts otel_exporter.py
 └─ otel_exporter.py
     ├─ every 5 s: GET otel:destinations, reload the exporters if it changed
     ├─ every 5 s: read queued rows, send them, mark them sent
     ├─ every 300 s: delete expired rows
     └─ OTLP/HTTP or gRPC ─► the OTLP receivers, the dashboard API among them
```

| Setting                    | Value                                                                          |
| -------------------------- | ------------------------------------------------------------------------------ |
| Command                    | `sys.executable otlp_exporter/otel_exporter.py`, registered as `otel_exporter` |
| `CANYONOS_OTEL_REDIS_HOST` | The Global Controller's primary Redis host; required, no default               |
| `CANYONOS_OTEL_REDIS_PORT` | Its port; required, no default                                                 |
| `CANYONOS_DATA_DIR`        | Folder for `otel_queue.db`; unset, the file sits beside `schema.py`            |

The Global Controller writes the destinations, creates the tables (`schema.init_db`)
and then starts the exporter, so the tables exist before the exporter reads them; the
exporter also creates them if missing. `ProcessSupervisor.check_and_respawn` restarts
the exporter on the next poll tick after it exits. On Kubernetes the operator sets
`CANYONOS_DATA_DIR` to `/var/lib/canyonos`, a 1 GiB `emptyDir`, so the queue does not
survive a Global Controller restart there.

## Writers and queue

Telemetry starts in each machine's Redis (on Kubernetes, the project's one Redis):

| Redis key                          | Holds                                                                     | Written by                                                                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `future:{future_id}`               | `request_id`, parent, agent, model, timings, tokens, result, failed, logs | `Future._submit_request`, `LocalController._execute_locally` and `_mark_future_failed`, the LLM Gateway's `Hooks.on_response`, `LogHandler.emit` |
| `controller:{host}:{port}:metrics` | The replica's metrics                                                     | `LocalController._metrics_loop`                                                                                                                  |
| `machine:{host}:metrics`           | The machine's metrics                                                     | the [machine metrics poller](MACHINE_METRICS_POLLER.md)                                                                                          |

The Global Controller copies them into the queue:

| When                          | Function                     | Writes                                                                          |
| ----------------------------- | ---------------------------- | ------------------------------------------------------------------------------- |
| Every poll, per replica       | `_poll_one_replica`          | One `agent` row in `metrics_waiting` from the replica's metrics hash            |
| Every poll, per machine Redis | `_send_telemetry_per_host`   | Trace and log rows for every `future:*` not yet queued as finished              |
| Every poll                    | `poll_machine_metrics`       | One `machine` row per machine (per pod on Kubernetes)                           |
| Each cleanup                  | `deliver_completed_requests` | A final snapshot of a completed request's futures, before they are cleaned up   |
| Each log record               | `ProcessLogHandler`          | The Global Controller's own INFO and above logs, when the config's `logs` is on |

`_send_telemetry_per_host` reads the machines in parallel and remembers, per machine,
the futures already queued with `finished_at`, so a poll reads only those still running
or new. `deliver_completed_requests` marks a request `telemetry:delivered:<id>` on every
machine once all its futures are terminal and written, which lets the cleanup remove
them.

The queue has one table per signal:

| Table             | Key                             | Main columns                                                         |
| ----------------- | ------------------------------- | -------------------------------------------------------------------- |
| `traces_waiting`  | `future_id`                     | `request_id` (becomes `session_id`), `finished_at`, `sent DEFAULT 0` |
| `metrics_waiting` | `sample_id`                     | `kind` (`machine` or `agent`), `observed_at`, `metrics` JSON, `sent` |
| `logs_waiting`    | `log_id`, `{future_id}:{index}` | `observed_at`, `attributes` JSON, `sent`                             |

Writes are upserts (`ON CONFLICT ... DO UPDATE`): rewriting a row refreshes its payload
but never resets `sent`. A finished or failed trace row is only overwritten by another
finished or failed version. A metric's `sample_id` is
`{kind}:{agent_id or host[:port]}:{observed_at in ns}`, so rereading the same sample
updates one row. The Global Controller's own log rows get a random `log_id`. The full
column lists are in the package's
[`TRACES.md`](https://github.com/CanyonCodeCoreAI/canyonos/blob/main/packages/core/canyonos_core/otlp_exporter/TRACES.md),
[`METRICS.md`](https://github.com/CanyonCodeCoreAI/canyonos/blob/main/packages/core/canyonos_core/otlp_exporter/METRICS.md)
and
[`LOGS.md`](https://github.com/CanyonCodeCoreAI/canyonos/blob/main/packages/core/canyonos_core/otlp_exporter/LOGS.md).

## Export loop

At startup the exporter creates the tables, connects to Redis, reads
`otel:destinations` and builds one exporter per destination for each signal. SIGTERM
and SIGINT stop the loop and shut the exporters down. Each trace exporter is probed
with an empty export, and a destination that does not answer is logged without
failing startup.

The loop wakes every second. Every `POLL_INTERVAL_SECONDS` (5) it reloads the
destinations if they changed, then, for each signal that has exporters, reads up to 512
rows with `sent = 0` (traces only once `finished_at` is set), converts them, and hands
the batch to `_deliver_and_mark`:

- The batch is exported once to every destination.
- Only if every destination accepts it are its rows marked sent (`*_mark_sent_many`).
- If any destination fails, every row stays at `sent = 0`, and the whole batch goes to
  every destination again on the next poll.

A signal with no exporters is flushed instead: `_flush_pending` deletes every row of
its table each poll. Every `DELETE_INTERVAL_SECONDS` (300) the loop deletes expired
rows; see [Failure and retry](#failure-and-retry).

## What conversion keeps

The converters turn queue rows into OTel objects. What the dashboard and other receivers
rely on:

- **Traces** (`trace_convert.py`): `session_id` becomes the trace ID, `future_id` the
  span ID and `parent_id` the parent span, so one request is one trace. A failed row
  gets an `exception` event and `StatusCode.ERROR`. Model, token counts and cost go out
  as `gen_ai.request.model` and `gen_ai.usage.*`, input and output as
  `langfuse.observation.input`/`output`, plus `project_id` and `gen_ai.agent.id`.
- **Metrics** (`metric_convert.py`): a `machine` row becomes a resource named
  `canyonos-machine-{host}` with gauges (the fields are listed on
  [Machine metrics poller](MACHINE_METRICS_POLLER.md#fields)). An `agent` row becomes a
  resource named after the agent, with `service.instance.id`, `host.name` and
  `canyonos.agent.port`, its gauges, its sums as cumulative, monotonic sums, and its
  status as `canyonos.agent.up`. Both carry `canyonos.project.id`.
- **Logs** (`log_convert.py`): each entry of a future's `logs` array is one record,
  carrying the same trace and span IDs as its span, so logs join their trace.
  `WARNING` is sent as `WARN` and `CRITICAL` as `FATAL`.

## Destinations and dashboard

`GlobalController._otel_destinations` resolves the list:

1. `otel.destinations` from the workflow config, with `${VAR}` expanded. Without the
   block it is `[LOCAL_DASHBOARD_DESTINATION]`, the dashboard API by its container
   name, `http://canyonos-dashboard-api:3000`, on the project's Docker network.
2. On Kubernetes (`CANYONOS_TARGET=kubernetes`), every destination on
   `host.docker.internal` or on the local dashboard is skipped with a log line, since
   a cluster has no way back to the laptop.
3. When `CANYONOS_DASHBOARD_OTLP_ENDPOINT` is set (the operator sets it when the
   cluster has a dashboard), a `canyonos-dashboard` HTTP destination is added.

`_write_otel_destinations` writes the result as JSON to `otel:destinations`, at startup
and on every config reload. An empty result writes nothing and deletes nothing, so a
value an earlier run left in a reused Redis stays in effect.

The exporter compares the raw key with the last value on every poll. When it changes,
it validates the list with the same rules as the config schema, builds new exporters
for all three signals, shuts down the old ones and swaps them in. A `grpc`
destination's endpoint is used as configured; for `http` and `http/protobuf`, the
trailing slash is stripped and `/v1/traces`, `/v1/metrics` or `/v1/logs` appended.

The dashboard API receives them in `telemetryRoutes`:

| Route              | Handler                | Writes                                                                         |
| ------------------ | ---------------------- | ------------------------------------------------------------------------------ |
| `POST /v1/traces`  | `ingest_trace_export`  | `otel_spans`, read by `requests.repo` and `metrics.repo`                       |
| `POST /v1/metrics` | `ingest_metric_export` | `otel_metrics` and `otel_metric_rollups` in one transaction, `monitoring.repo` |
| `POST /v1/logs`    | `ingest_logs_export`   | `otel_logs`, read by `monitoring.repo`                                         |

`map_span` stores `project_id` as `canyon.project.id`.

## Failure and retry

At startup:

| Situation                           | What happens                                                                 |
| ----------------------------------- | ---------------------------------------------------------------------------- |
| The queue database can't be created | Fatal exit; `ProcessSupervisor` restarts the exporter                        |
| Redis unreachable or env missing    | Fatal exit; `ProcessSupervisor` restarts the exporter                        |
| No usable `otel:destinations`       | Empty exporter lists (flush mode): `_flush_pending` deletes every queued row |

When the destinations are reloaded:

| Situation                                    | What happens                                     |
| -------------------------------------------- | ------------------------------------------------ |
| Raw value unchanged                          | Keep the current exporters                       |
| Missing or invalid value, or a build failure | Keep the current exporters; retry next poll      |
| A valid, changed value                       | Build the new exporters, shut down the old, swap |

When a batch is delivered:

| Situation                                     | What happens                                   |
| --------------------------------------------- | ---------------------------------------------- |
| `exporter.export` raises or returns `FAILURE` | `sent` stays 0; retry next poll                |
| HTTP traces: `rejected_spans > 0`             | `sent` stays 0; retry the whole batch          |
| gRPC traces: a partial rejection              | Not observable; `SUCCESS` can mark it all sent |
| One destination fails after others succeeded  | Retry to every destination                     |
| Export succeeds, `mark_sent_many` fails       | Retry; receivers may see duplicates            |

When a row is converted:

| Situation                                        | What happens                                                  |
| ------------------------------------------------ | ------------------------------------------------------------- |
| Trace conversion or encoding fails, tries 1 to 4 | Skip the row; `sent` stays 0                                  |
| Trace conversion fails a fifth time              | Send `invalid_row_placeholder_span` instead, then ack the row |
| A metric or log row raises                       | Skip the row; `sent` stays 0 until it expires                 |
| A metric or log row is empty or unparseable      | Mark it sent (`metric_mark_sent`, `log_mark_sent`)            |

`_delete_expired_rows` deletes rows whether or not they were sent:

| Table             | Deleted when                              | Retention constant               |
| ----------------- | ----------------------------------------- | -------------------------------- |
| `traces_waiting`  | `finished_at` is older than the retention | `TRACE_RETENTION_SECONDS` = 1800 |
| `metrics_waiting` | `observed_at` is older than the retention | `METRIC_RETENTION_SECONDS` = 600 |
| `logs_waiting`    | `observed_at` is older than the retention | `LOG_RETENTION_SECONDS` = 1800   |

A trace with `finished_at IS NULL` is in flight and is never deleted.

Trace attempt counts live in memory only, so an exporter restart starts them again.
Flush mode lasts until a valid `otel:destinations` value appears. A signal whose table
stays empty for 12 polls while its count is 0 gets a warning that the Global Controller
may be writing to a different `otel_queue.db`, since SQLite creates a missing file
rather than failing.

These retentions apply only to the exporter's queue in the Global Controller's
container. The dashboard API prunes its own tables once an hour: raw ticks in
`otel_metrics` older than `METRICS_RAW_RETENTION_DAYS` (default 3), and rollups in
`otel_metric_rollups` older than `METRICS_ROLLUP_RETENTION_DAYS` (default 120). The
queue only has to hold a row until it is delivered; the dashboard keeps what it received
for as long as the monitoring screens need it.

## Changing it

- New signal field: add the column in `schema.py` (`CREATE TABLE IF NOT EXISTS` adds
  no column to an existing file), write it in `otel_writer.py`, and map it in the
  converter. A new machine or agent metric needs no column: it lives in the `metrics`
  JSON and needs only a mapping in `metric_convert.py`.
- New destination option: `schema/otel_destinations.py` holds the rules both the config
  schema and the exporter apply.
