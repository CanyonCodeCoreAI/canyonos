# CanyonOS Core — Architecture

## Process layout

```
┌──────────────────────────── GC container ────────────────────────────┐
│                                                                      │
│  server.py (Flask :8000)  ◀── POST /deploy /clean, GET /status      │
│       │ spawns                          /endpoints  (host CLI)       │
│       ▼                                                              │
│  cli.py deploy ──▶ GlobalController                                  │
│                      │  ProcessSupervisor                            │
│                      ├──▶ reconciler      (subprocess)               │
│                      └──▶ otel_exporter   (subprocess)               │
│                                                                      │
│  SQLite otel_queue.db   (GC writes, otel_exporter reads)             │
└──────────────────────────────────┬───────────────────────────────────┘
                                   │ host docker.sock / ssh
                                   ▼  (sibling containers, one set per host)
┌──────────────────────────── node (host) ─────────────────────────────┐
│                                                                      │
│  canyonos-redis-<host>        canyonos-metrics-<host>                │
│         ▲  ▲  ▲                 (machine_metrics_poller)             │
│         │  │  │                                                      │
│  ┌──────┴──┴──┴───────────────┐  ┌────────────────────────────────┐  │
│  │ canyonos-<agent>-<i>       │  │ canyonos-<workflow>-0          │  │
│  │  LocalController  :50051   │  │  LocalController (routing only)│  │
│  │  agent code (real class)   │  │  workflow fn + agent stubs     │  │
│  │ llm_gateway 127.0.0.1:8081 │  │  deploy.py Flask  :api_port    │  │
│  └────────────────────────────┘  │  llm_gateway  127.0.0.1:8081   │  │
│                                  └────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

## GC ⇄ reconciler ⇄ LC

```
      GlobalController                 Redis (primary)                 reconciler
      ────────────────                 ───────────────                 ──────────
  YAML ─▶ write_config_specs ───────▶ agent:<n>:spec
                                       agents:active  ───────────────▶ refresh specs
          set_replicas ─────────────▶ agent:<n>:desired_replicas ───▶ get_desired
          replace_replica ──────────▶ reconciler:replace ───────────▶ remove slot
          stop() ───────────────────▶ reconciler:draining (TTL) ────▶ desired = 0
          _request_reconcile ─LPUSH─▶ reconciler:wake ─────BRPOP────▶ reconcile()
                                                                         │
                                                  ┌──────────────────────┘
                                                  ▼
                                   remove unwanted / unhealthy ─▶ docker rm -f / terminate EC2
                                   ensure_instances            ─▶ docker run / EC2 + ssh
                                                  │
                                                  ├─▶ agent_instance:<prov>:<n>:<i>
                                                  └─▶ routing_table:* ──▶ every node Redis
                                                                               │
                              LocalController (each container)                 │
                              ────────────────────────────────                 │
                              reads routing_table:*, policy:rules  ◀───────────┘
                              writes controller:<ep>:status
                                     controller:<ep>:metrics  ──▶ GC poll, reconciler health


   GC ──gRPC Cleanup──▶ LC          (the only direct GC → LC call)
   GC ◀──── Redis reads ──── LC     (status, metrics, future:*)
```

## GC poll tick

```
 run()  (every poll_interval)
  │
  ├─ supervisor.check_and_respawn()          reconciler, otel_exporter
  │
  ├─ for each agent_instance  (parallel) ─── _poll_one_instance
  │     │
  │     ├─ GET  controller:<ep>:status       ─▶ status transitions
  │     ├─ SCAN future:*   ──▶ send_telemetry ─▶ SQLite traces_waiting, logs_waiting
  │     └─ HGETALL controller:<ep>:metrics    ─▶ SQLite metrics_waiting (kind=agent)
  │
  ├─ _poll_machine_metrics
  │     └─ HGETALL machine:<host>:metrics     ─▶ SQLite metrics_waiting (kind=machine)
  │
  └─ _trigger_cleanup
        ├─ SMEMBERS request:completed          (every node Redis)
        ├─ gRPC Cleanup(request_ids) ────────▶ every LC
        │                                        └─ EXPIRE future:*, request:<id>:futures
        │                                           DEL affinity:<id>
        └─ SREM request:completed
```

## Request lifecycle (workflow API)

```
 client                    workflow container (deploy.py)                Redis
 ──────                    ──────────────────────────────                ─────
 POST /<fn> {body} ──────▶ request_id = new
                           SET request:<id>:status = pending ──────────▶
 ◀────── 202 {request_id}  thread: _execute_workflow
                             status = running ─────────────────────────▶
                             result = workflow_fn(body)
                               (stub calls create Futures, see below)
                             resolve every Future in result (.value())
                             SET request:<id>:result, status = done ───▶
                             SADD request:completed ───────────────────▶  (GC cleanup)
 GET /status/<id> ───────▶ GET request:<id>:status / :result ◀─────────
 ◀────── {status, result}
```

## Future: origin → executor → origin

```
 ORIGIN container                                          EXECUTOR container
 (workflow or calling agent)                               (target agent)
 ─────────────────────────                                 ──────────────────

 stub.method(args)
   │
   ├─ HSET future:<id> {service, method, args, parent}  ─▶ origin Redis
   ├─ SADD request:<rid>:futures
   └─ gRPC Execute ──▶ own LC (localhost:50051)
                         │
                         ├─ SET NX execute:<ep>:<id>:accepted   (dedup)
                         ├─ policy:rules check
                         ├─ pick endpoint
                         │    route_to ▸ affinity:<rid> (stateful) ▸ random(routing_table:endpoints)
                         ├─ for each Future arg: SADD future:<arg>:consumers ← executor
                         │
                         └─ gRPC Execute {origin, route_to} ──────────▶ LC
                                                                         │ queue → thread pool
                                                                         ├─ HSET future:<id>  ─▶ executor Redis
                                                                         ├─ wait for Future args in executor Redis
                                                                         ├─ agent.method(**args)
                                                                         │     └─ LLM calls ─▶ llm_gateway
                                                                         ├─ HSET result | failed/error,
                                                                         │       finished_at, cpu, gpu
                                                                         │
                         ┌───────────── gRPC WriteResult {full hash} ────┤
                         ▼                                               └─ WriteResult ─▶ each consumer
                       LC: HSET future:<id> ─▶ origin Redis                  of future:<id>
                         └─ re-fan to consumers registered here
   │
 future.value()
   └─ poll future:<id> every 10ms until result | failed ◀─ origin Redis
```

## Future chaining (a Future passed as an argument)

```
 workflow:   a = AgentA().f(x)          b = AgentB().g(a)          b.value()

   origin LC ──Execute f──▶ AgentA LC
   origin LC ──Execute g──▶ AgentB LC      (future:a:consumers += AgentB)
                              │
                              └─ g waits for future:a in AgentB's Redis
   AgentA LC ── f done ──WriteResult(a)──▶ origin LC ──fan-out──▶ AgentB LC
                                                                     └─ g runs
   AgentB LC ── g done ──WriteResult(b)──▶ origin LC ─▶ b.value() returns
```

## LLM call

```
 agent code (openai / anthropic / boto3 SDK)
   │  base URL pinned by docker -e  ─▶ http://127.0.0.1:8081/{openai/v1|anthropic|bedrock}
   │  header X-Canyonos-Future-ID   ◀─ thread-local current future (httpx patch / boto3 hook)
   ▼
 llm_gateway  core.proxy_request
   └─ provider.forward ───────────▶ api.openai.com / api.anthropic.com / bedrock-runtime
         │ response (or stream)
         ▼
   hooks.on_response
     └─ HSET future:<id> {model, input/output/cache token counts, errors} ─▶ node Redis
```

## Telemetry

```
  EMITTERS (node)                        BUFFER (GC process)                 EXPORT (otel_exporter)
  ───────────────                        ───────────────────                 ──────────────────────

  LC _execute_locally ─┐
  LogHandler (logs) ───┼─▶ future:<id> ──┐
  llm_gateway (tokens) ──┘               │ SCAN each tick
                                         ├──▶ otel_writer ──▶ traces_waiting ─┐
                                         │     (+ token &     logs_waiting ───┤
                                         │      server cost)                  │
  LC metrics thread ──▶ controller:<ep>:metrics ──▶ metrics_waiting (agent) ──┤
                                                                              │ every 5s
  metrics poller ─────▶ machine:<host>:metrics ───▶ metrics_waiting (machine) ┤ sent = 0
                                                                              ▼
                                                      trace_convert / metric_convert / log_convert
                                                                              │
                                       otel:destinations (Redis) ─▶ exporters │
                                                                              ▼
                                                   OTLP gRPC  <endpoint>
                                                   OTLP HTTP  <endpoint>/v1/{traces,metrics,logs}
                                                                              │
                                                  all destinations ok ─▶ sent = 1
                                                  no destinations    ─▶ DELETE rows
                                                  every 5 min        ─▶ prune old rows
```
