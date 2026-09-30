# OTLP Exporter — Architecture

## Where it runs

```
┌──────────────────────── canyonos-global-controller container ────────────────────────┐
│  ┌─────────────────────────────┐      ProcessSupervisor.register("otel_exporter")      │
│  │ GlobalController            │ ───────────────────────────────────────────────┐      │
│  │ _poll_controllers           │       ┌────────────────────────────────────────────┐  │
│  │ _poll_machine_metrics       │       │ python otlp_exporter/otel_exporter.py       │  │
│  │ schema.init_db              │       │ main                                       │  │
│  └──────────┬──────────────────┘       │ _reload_destinations_if_changed            │  │
│             │                          │ _trace_send_pending                         │  │
│             │ writes                   │ _metric_send_pending                        │  │
│             ▼                          │ _log_send_pending                           │  │
│  ┌─────────────────────────────┐ reads └─────────────────────┬──────────────────────┘  │
│  │ schema.DB_PATH              │◀─────────────────────────────┘                         │
│  │ controller/utils/           │                                                       │
│  │   otel_queue.db             │                                                       │
│  └─────────────────────────────┘                                                       │
│  ProcessSupervisor.check_and_respawn ──▶ restarts "otel_exporter" after an exit       │
└───────────────┬───────────────────────────────────────────────────┬───────────────────┘
                │ RedisClient                                      │ OTLP/HTTP or gRPC
                ▼                                                  ▼
       ┌──────────────────┐                              ┌──────────────────────────┐
       │ node Redis       │                              │ configured OTLP receivers│
       │ otel:destinations│                              │ including dashboard API  │
       │ future:*         │                              └──────────────────────────┘
       └──────────────────┘
```

## Writers and queue

```
┌────────────────────────────── node Redis producers ──────────────────────────────┐
│ Future._submit_request ───────────────┐                                           │
│ LocalController._execute_locally ─────┼──▶ future:{future_id} hash                │
│ LLM Gateway Hooks.on_response ──────────┤      request_id, parent, agent, model,     │
│ LocalController._mark_future_failed ──┤      created_at, finished_at, tokens,      │
│ LogHandler.emit ──────────────────────┘      result, failed, logs, ...             │
│ LocalController._metrics_loop ───────────▶ controller:{host}:{port}:metrics       │
│ Machine Metrics Poller ──────────────────▶ machine:{host}:metrics                 │
└──────────────────────────────────┬─────────────────────┬──────────────────────────┘
                                   ▼                     ▼
GlobalController._poll_one_instance                 GlobalController._poll_machine_metrics
        │                                                  │
        ├─ send_telemetry                                  └─ metric_write_rows
        │    └─ _pull_telemetry
        │         └─ scan_keys("future:*")
        │              ├─ _trace_write_rows ──────────────┐
        │              └─ _log_write_rows ─────────────┐  │
        └─ HGETALL controller:{endpoint}:metrics        │  │
             └─ metric_write_rows ───────────────────┐  │  │
                                                    ▼  ▼  ▼
┌────────────────────── schema.DB_PATH: controller/utils/otel_queue.db ─────────────┐
│ traces_waiting                    metrics_waiting               logs_waiting       │
│ PK future_id                      PK sample_id                  PK log_id           │
│ request_id ─▶ session_id          kind = machine | agent       {future_id}:{index} │
│ finished_at                       observed_at                   observed_at         │
│ sent DEFAULT 0                    metrics JSON                  attributes JSON     │
│                                   sent DEFAULT 0                sent DEFAULT 0      │
│ ON CONFLICT ... DO UPDATE ──▶ payload refreshed; sent is never reset              │
└───────────────────────────────────────────────────────────────────────────────────┘
```

## Export loop

```
main
 │  init_db
 │  RedisClient(CANYONOS_OTEL_REDIS_HOST, CANYONOS_OTEL_REDIS_PORT)
 │  SIGTERM / SIGINT ──▶ _handle_shutdown
 ▼
while _running  (sleep 1 second)
 │
 ├─ every POLL_INTERVAL_SECONDS = 5
 │    ├─ _reload_destinations_if_changed
 │    ├─ _trace_send_pending
 │    │    └─ SELECT finished_at IS NOT NULL AND sent = 0
 │    │       LIMIT MAX_SPANS_PER_POLL = 512
 │    │       └─ trace_row_to_span ──▶ exporter.export(spans)
 │    ├─ _metric_send_pending
 │    │    └─ SELECT sent = 0 LIMIT MAX_SPANS_PER_POLL = 512
 │    │       └─ metric_row_to_resource_metrics ──▶ MetricsData
 │    │          └─ exporter.export(metrics_data)
 │    └─ _log_send_pending
 │         └─ SELECT sent = 0 LIMIT MAX_LOGS_PER_POLL = 512
 │            └─ log_row_to_log_records ──▶ exporter.export(records)
 │
 ├─ each converted batch
 │    └─ _deliver_and_mark
 │         ├─ export once to every (destination_name, exporter)
 │         ├─ any destination fails ──▶ leave every batch id at sent = 0
 │         └─ all destinations accept
 │              ├─ trace_mark_sent_many
 │              ├─ metric_mark_sent_many
 │              └─ log_mark_sent_many
 └─ every PRUNE_INTERVAL_SECONDS = 300 ──▶ _prune_expired_rows
```

## Trace conversion

```
traces_waiting row
 └─ trace_convert.trace_row_to_span
      ├─ session_id ─────────────────────────▶ SpanContext.trace_id
      ├─ future_id ──────────────────────────▶ SpanContext.span_id
      ├─ parent_id ──────────────────────────▶ parent SpanContext.span_id
      ├─ started_at / finished_at ───────────▶ start_time / end_time (epoch nanos)
      ├─ name ───────────────────────────────▶ ReadableSpan.name
      ├─ failed = 1 ─────────────────────────▶ Event("exception") + StatusCode.ERROR
      └─ attributes
           model ────────────────────────────▶ gen_ai.request.model
           input_token_count ────────────────▶ gen_ai.usage.input_tokens
           output_token_count ───────────────▶ gen_ai.usage.output_tokens
           total_cost ───────────────────────▶ gen_ai.usage.cost
           input / output ───────────────────▶ langfuse.observation.input / output
           project_id ───────────────────────▶ project_id
           agent_id ─────────────────────────▶ gen_ai.agent.id
                                               │
                                               ▼
                                      ReadableSpan (SpanKind.INTERNAL)
```

## Metric conversion

```
metrics_waiting row ──▶ metric_convert.metric_row_to_resource_metrics
                                   │
               ┌───────────────────┴────────────────────┐
               │ kind = machine                        │ kind = agent
               ▼                                       ▼
    _machine_resource_metrics               _agent_resource_metrics
               ├─ _MACHINE_GAUGES ──▶ Gauge           ├─ _AGENT_GAUGES ──▶ Gauge
               ├─ _CAPACITY_GAUGES ─▶ Gauge           ├─ _AGENT_SUMS ────▶ Sum
               │                                       │   CUMULATIVE, monotonic
               │                                       └─ status ─────────▶ canyonos.agent.up
               ├─ service.name = canyonos-machine-{host}
               ├─ host.name
               └─ canyonos.project.id
                                                       ├─ service.name = agent_name
                                                       ├─ service.instance.id = agent_id
                                                       ├─ host.name / canyonos.agent.port
                                                       └─ canyonos.project.id
               └───────────────────┬───────────────────┘
                                   ▼
                    ResourceMetrics ──▶ MetricsData(resource_metrics)
```

## Log conversion

```
future:{future_id}.logs JSON array
        │
        └─ _log_write_rows ──▶ one logs_waiting row per entry
                                      ▼
                         log_convert.log_row_to_log_records
        ┌─────────────────────────────┼──────────────────────────────────┐
        │                             │                                  │
 session_id (hex)              future_id (hex)                  attributes JSON
        │                             │                                  │
        ▼                             ▼                                  ▼
 SpanContext.trace_id          SpanContext.span_id          canyonos.agent.id
                                                           canyonos.agent.name
 observed_at ───────────────▶ timestamp + observed_timestamp canyonos.endpoint
 severity_number ───────────▶ SeverityNumber                 logger.name
 severity_text ─────────────▶ WARNING → WARN                 exception.*
                              CRITICAL → FATAL
 body ──────────────────────▶ LogRecord.body
 agent_id ──────────────────▶ Resource service.name
                                      │
                                      ▼
                               ReadableLogRecord
```

## Destinations and dashboard

```
global_controller.yaml
otel.destinations
      │
      ├─ absent ──▶ _otel_destinations = None ──▶ no SET; existing Redis key remains
      ├─ GlobalController._otel_destinations
      │      └─ ControllerContext._expand_env_value
      │
      └─ GlobalController._write_otel_destinations
             └─ SET otel:destinations = JSON list ───────────────┐
                                                                 ▼
                                                      exporter RedisClient
                                                                 │
                                       every poll ──▶ GET otel:destinations
                                                                 │ changed
                                                                 ▼
                                             _reload_destinations_if_changed
                                              ├─ _trace_build_exporters
                                              ├─ _metric_build_exporters
                                              ├─ _log_build_exporters
                                              └─ _shutdown_exporters(old)
destination protocol = grpc              destination protocol = http | http/protobuf
endpoint used as configured              endpoint.rstrip("/") + signal path
          │                                          │
          │                                          ├─ /v1/traces
          │                                          ├─ /v1/metrics
          │                                          └─ /v1/logs
          └───────────────────────┬──────────────────┘
                                  ▼
                     configured OTLP receiver(s)
                                  │
                                  ▼
┌──────────────────────────── dashboard API: telemetryRoutes ───────────────────────────┐
│ POST /v1/traces  ──▶ ingest_trace_export  ──▶ otel_spans ──▶ requests_repo, metrics_repo │
│ POST /v1/metrics ──▶ ingest_metric_export ──▶ otel_metrics                          │
│ POST /v1/logs    ──▶ ingest_logs_export    ──▶ otel_logs                             │
│ map_span: project_id ──▶ canyon.project.id                                           │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

## Failure and retry

```
startup
  ├─ Redis unreachable / env missing ──▶ fatal exit ──▶ ProcessSupervisor restart
  └─ no usable otel:destinations ──────▶ empty exporter lists (flush mode)
                                                │
                                                └─ _flush_pending ──▶ flush_all
                                                   DELETE every row from each table

destination reload
  ├─ raw unchanged ────────────────────▶ keep current exporters
  ├─ invalid / build failure ──────────▶ keep current exporters; retry next poll
  └─ valid changed value ──────────────▶ build new ─▶ shut down old ─▶ swap

batch delivery
  ├─ exporter.export exception / FAILURE ───────────▶ sent stays 0 ─▶ retry next poll
  ├─ HTTP traces: rejected_spans > 0 ───────────────▶ sent stays 0 ─▶ retry whole batch
  ├─ gRPC traces: partial rejection not observable ─▶ SUCCESS can mark whole batch sent
  ├─ one destination fails after others succeeded ─▶ retry to every destination
  └─ export succeeds, mark_sent_many fails ─────────▶ retry; receiver may see duplicates

row conversion
  ├─ trace conversion/encoding failure
  │    ├─ attempts 1..4 ────────────────────────────▶ skip row; sent stays 0
  │    └─ attempt 5 ──▶ invalid_row_placeholder_span ──▶ normal fan-out + ack
  ├─ metric row empty/unparseable ──▶ metric_mark_sent
  └─ log row empty/unparseable ─────▶ log_mark_sent

_prune_expired_rows  (sent or unsent)
  ├─ traces_waiting: finished_at older than TRACE_RETENTION_SECONDS = 1800
  ├─ metrics_waiting: observed_at older than METRIC_RETENTION_SECONDS = 600
  └─ logs_waiting: observed_at older than LOG_RETENTION_SECONDS = 1800
       finished_at IS NULL ──▶ never pruned as an in-flight trace
```
