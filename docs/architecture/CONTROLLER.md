# Controller — Architecture

## Runtime layout

```
CLI host:         ──▶          8000
                         ┌───────┴─ canyonos-<project>-global-controller ─┐
                         │ canyonos_core.server                           │
                         │ POST /deploy ──▶ canyonos_core.cli deploy      │
                         │                         │                      │
                         │                  GlobalController             │
                         │                    ├─ reconciler               │
                         │                    └─ otel_exporter             │
                         └────────────────────────┬───────────────────────┘
                                                  │ 
┌──────────────────────────── one machine ────────┼───────────────────────────┐
│ canyonos-<project>-redis-<host> ◀─ RedisClient ─┘  redis_port (6379)        │
│        ▲                                                                     │
│        ├── agent replica: LocalController + agent code                      │
│        │      gRPC [::]:50051; host publication <host>:<host_port>           │
│        │      address ──▶ <container_name>:50051 (local)                     │
│        │      LLM gateway ──▶ 127.0.0.1:8081                                   │
│        │                                                                     │
│        ├── canyonos-<project>-endpoint-0 (GC's machine): routing-only        │
│        │      LocalController + gunicorn; host <api_port> ──▶ container 8080 │
│        │      address ──▶ <container_name>:50051, or                         │
│        │        <CANYONOS_PRIVATE_IP>:<host_port> when that is set           │
│        │                                                                     │
│        └── canyonos-<project>-metrics-<host>                                 │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Global Controller startup

```
POST /deploy
     │
     ▼
canyonos_core.server.deploy
     └─▶ python -m canyonos_core.cli deploy -c <config_path>
              │
              ├─ _run_build
              ├─ _ensure_grpc_stubs_importable
              └─ GlobalController(config_path)
                    ├─ ControllerContext.__init__
                    │    ├─ _load_config ──▶ .env + global_controller.yaml
                    │    │                    + endpoint spec after the agents
                    │    ├─ resolve_env_file
                    │    └─ RedisClient
                    ├─ orchestrator.remove_stale_containers ──▶ _remove_stale_containers
                    ├─ orchestrator.start_support_services ──▶ _launch_redis_containers
                    │                         _launch_metrics_collectors
                    ├─ _apply_config
                    │    ├─ write_config_specs
                    │    ├─ _apply_configured_replicas
                    │    ├─ _write_policies
                    │    ├─ _write_identity
                    │    └─ HSET endpoint:address
                    ├─ schema.init_db
                    ├─ ProcessSupervisor.start_all
                    │    ├─ reconciler (orchestrator.register_background_processes)
                    │    └─ otel_exporter
                    └─ _cleanup_loop ──▶ _wait_for_healthy ──▶ run
                                                               └─ _poll_controllers
```

## The orchestrator

The Global Controller decides: the config, policies, how many replicas each agent
should have, cleanup and telemetry. Starting, replacing and removing those replicas is
the orchestrator's job. It goes through one object, `gc.orchestrator`
(`controller/orchestrator.py`), so no other Global Controller code knows what runs them.

`CanyonOrchestrator` (Docker and EC2): CanyonOS runs the replicas itself.

| `gc.orchestrator` | What `CanyonOrchestrator` does |
| --- | --- |
| `start_support_services()` | one Redis and one metrics collector per machine |
| `register_background_processes()` | the reconciler process, under the process supervisor |
| `set_replicas(agent, n)` | the agent's desired count in Redis, then wakes the reconciler |
| `replace_replica(agent, slot)` | a replacement request the reconciler acts on |
| `replica_log_tail(replica, lines)` | the replica container's last output, read on its machine |
| `remove_all_replicas()`, `stop_support_services(clean)` | the reconciler drains and removes every replica, then Redis and the collectors go |

## Local Controller startup

```
agent image                              core image (canyonos-<project>-endpoint-0)
python local_controller.py --port 50051  python -m canyonos_core.endpoint
             │                                      ├─ LocalController(
             │                                      │    publish_ready=False)
             │                                      ├─ gunicorn :8080 (2 workers × 16 threads)
             │                                      │    └─ worker_app ──▶ create_app(agent, method)
             │                                      ├─ threading.Thread(target=run_controller)
             │                                      │    └─ controller.run stops ──▶ terminate gunicorn
             │                                      ├─ mark_ready once :8080 answers
             │                                      └─ gunicorn exits ──▶ mark_failed, exit
             └──────────────────┬─────────────────────────────────────────
                                ▼
                      LocalController.__init__
                                ├─ start_server ──▶ LocalControllerServicer
                                │                    └─ queue.Queue()
                                ├─ RedisClient(CANYONOS_REDIS_HOST,
                                │              CANYONOS_REDIS_PORT)
                                ├─ _start_llm_gateway ──▶ 127.0.0.1:8081 (agent only)
                                │                         └─ canyonos_core.llm_gateway
                                ├─ GET controller:<host>:<port>:replica_id
                                ├─ SET status = initializing
                                ├─ _metrics_loop
                                ├─ _load_agent
                                └─ mark_ready ──▶ status = healthy (publish_ready)
```

## Endpoint serving

[Endpoint](ENDPOINT.md) covers the endpoint container end to end.

```
gunicorn worker (×2) ─────────────▶ create_app(CANYONOS_ENDPOINT_AGENT, CANYONOS_ENDPOINT_METHOD)
                                              └─ Flask :8080
                         ┌────────────────────┴─────────────────────┐
                         ▼                                          ▼
                  POST /<method>                         GET /status/<request_id>
                         │                                          ├─ GET request:<id>:future
                         ├─ kwargs.pop("_context", {})              │    └─ missing ──▶ 404
                         ├─ uuid.uuid4().hex                        └─ HGETALL future:<future_id>
                         ├─ SET request:<id>:context                     ├─ failed ──▶ error (error_message)
                         ├─ set_request_id                               ├─ result ──▶ done
                         ├─ Future(parent=None, agent, method,           ├─ oldest of request:<id>:waiting ──▶ input_required (question)
                         │         args=kwargs)                          └─ else   ──▶ pending
                         ├─ SET request:<id>:future = <future_id>
                         └─ 202 {"request_id": <id>}
                                  │ Execute ──▶ target agent replica
                                  ▼
                           _execute_locally (parent is None)
                                  ├─ <method>(**kwargs) ──▶ _resolved
                                  ├─ non-dict result ──▶ {"value": result}
                                  ├─ error ──▶ HSET error_message
                                  ├─ WriteResult ──▶ endpoint LocalController
                                  └─ SADD request:completed

input() | LangGraph interrupt() | Agents SDK approval   (human_input.install)
     └─ ask_human(question, input_schema) ──▶ Future(agent_name="endpoint", method="ask_human") ──▶ routed like any call
                                              ▼
                        endpoint LocalController._process_request
                              └─ agent_name is "endpoint"
                                   ├─ HSET future:<qid> ◀── the asker's record fields
                                   ├─ SADD request:<id>:futures ◀── qid, future:<qid>:consumers ◀── asking replica
                                   ├─ LPUSH request:<id>:waiting {future_id, question}
                                   └─ request already finished ──▶ _fail_waiting_questions

POST /answer/<request_id>
     ├─ RPOP request:<id>:waiting
     │    └─ empty ──▶ 409
     ├─ WriteResult {future_id, result, finished_at} ──▶ endpoint LocalController
     │    └─ HSET future:<qid> ──▶ _fan_out_to_consumers ──▶ asking replica
     └─ 202 {"request_id": <id>}

root result arrives at the endpoint (WriteResult, no parent)
     └─ on_request_done, on its own thread ──▶ _fail_waiting_questions
                                                    └─ RPOP each ──▶ _mark_future_failed ──▶ _fan_out_to_consumers ──▶ asking replica
```

A root call is one whose Future has no parent. `_execute_locally` resolves every nested Future in its result, wraps a non-dict result in `{"value": ...}`, stores `error_message` on failure, and adds the request to `request:completed`.

## Request lifecycle

```
calling agent   ──▶ generated agent stub ──▶ Future.__init__
                                              │
                         origin Redis ◀────────┤ HSET future:<future_id>
                                              ├─ SADD request:<request_id>:futures
                                              └─ Future._submit_request
                                                       │ LocalController.Execute
                                                       ▼
                                      LocalControllerServicer.Execute
                                                       └─ request_queue.put
                                                               │
                                                               ▼
                                      LocalController.run ──▶ _process_request
                                                               │
                      policy:rules ──▶ _check_policy            │
   routing_table:* ──▶ _load_routing ──▶ _resolve_address (memory, skips replicas marked down)
                                                               │
                         ┌─────────────────────────────────────┴──────────────┐
                         │ address == _my_address                           │ remote
                         ▼                                                  ▼
             ThreadPoolExecutor.submit                              _forward_request
                         │                                          Execute.future (2 s)
                         │                                          └─ unreachable / timeout ──▶ mark down 30 s
                         │                                               └─ request_queue.put again (Timer backoff,
                         │                                                  unreachable: picks again; ≤ 8 retries)
                         ▼                                                  │
                  _execute_locally                                          ▼
                         ├─ _resolve_future_args                executor _execute_locally
                         ├─ agent method(**args)                            │
                         ├─ HSET future:<future_id>                         │
                         └─ _fan_out_to_consumers              _send_result_callback
                                                                            │ WriteResult
                                                                            ▼
                                                        origin LocalControllerServicer
                                                                            ├─ HSET future:<id>
                                                                            └─ _fan_out_to_consumers
Future.value ◀── poll origin future:<id> ◀───────────────────────────────────────────┘
     └─ root future: GET /status/<request_id> reads future:<id>
```

## Futures and cleanup

```
origin Future                                      executor LocalController
  id = secrets.token_hex(8)                              │
  request_id = get_request_id()                          │
  parent = get_current_future_id()                       │
  HSET future:<id> ── Execute ──────────────────────────▶│
                                                         ├─ HSET future:<id>
                                                         ├─ agent method
                                                         ├─ result | failed | error
                                                         ├─ finished_at | cpu_resource |
                                                         │  gpu_resource | agent | queue_time
                                                         └─ WriteResult(full future hash)

dependency Future arg ──▶ SADD future:<id>:consumers
                                  └─ _fan_out_to_consumers ──▶ WriteResult

future:<id>:children ──▶ Future._children_key
                     └─▶ _cleanup_request EXPIRE

root future (parent=None) done ──▶ SADD request:completed
                                         │
                                         ▼
                            GlobalController._trigger_cleanup
                              ├─ SMEMBERS on every machine Redis
                              ├─ union request_ids
                              └─ Cleanup ──▶ every LocalControllerServicer
                                                  └─ _cleanup_request
                                                       ├─ SETNX request:<id>:cleanup_lock
                                                       ├─ SMEMBERS request:<id>:futures
                                                       ├─ EXPIRE NX request:<id>:futures
                                                       ├─ EXPIRE NX future:<id>
                                                       ├─ EXPIRE NX future:<id>:children
                                                       ├─ EXPIRE NX future:<id>:consumers
                                                       ├─ DELETE affinity:<request_id>
                                                       └─ DELETE cleanup_lock
                              └─ all acknowledged ──▶ SREM request:completed
```

## Redis ownership

```
GlobalController / ControllerContext
  writes ──▶ agents:active, agent:<name>:spec, agent:<name>:,
             agent:<name>:resources, agent:<name>:desired_replicas,
             reconciler:wake, policy:rules, controller:identity,
             otel:destinations, request:completed, endpoint:address
  reads  ◀── agent_instance:*, agent:<name>:instances,
             controller:<host>:<port>:status,
             controller:<host>:<port>:metrics, machine:<host>:metrics,
             future:*, agent:<agent_id>:hourly_cost, request:completed

LocalController / LocalControllerServicer
  writes ──▶ controller:<host>:<port>:status,
             controller:<host>:<port>:metrics,
             request:<request_id>:context, request:<request_id>:futures,
             request:<request_id>:cleanup_lock, future:<future_id>,
             future:<future_id>:children, future:<future_id>:consumers,
             affinity:<request_id>, execute:<address>:<future_id>:accepted,
             request:completed, request:<request_id>:waiting
  reads  ◀── controller:<host>:<port>:replica_id, controller:<host>:<port>:draining,
             routing_table:addresses, routing_table:stateful, policy:rules,
             request:<request_id>:context, request:<request_id>:futures,
             request:<request_id>:future,
             future:<future_id>, future:<future_id>:consumers,
             affinity:<request_id>

endpoint / Future
  writes ──▶ request:<request_id>:context, request:<request_id>:future,
             request:<request_id>:futures, future:<future_id>,
             future:<future_id>:consumers, request:<request_id>:waiting (RPOP)
  reads  ◀── request:<request_id>:future, future:<future_id>,
             request:<request_id>:waiting

reconciler
  writes ──▶ agent_instance:*, agent:<name>:instances, controller:<host>:<port>:draining,
             routing_table:agents, routing_table:addresses,
             routing_table:stateful
```

## gRPC services

```
proto/local_controller.proto: service LocalController
  Execute(JsonResponse) returns (JsonResponse)
    Future._submit_request ───────────▶ local LocalControllerServicer
    LocalController._forward_request ─▶ remote LocalControllerServicer
    action ──▶ request_queue.put(request.response)

  WriteResult(JsonResponse) returns (JsonResponse)
    LocalController._send_result_callback ──▶ origin / consumer
    Future._notify_consumers ───────────────▶ consumer
    action ──▶ HSET future:<future_id> ──▶ _fan_out_to_consumers

  Cleanup(JsonResponse) returns (JsonResponse)
    GlobalController._trigger_cleanup ──▶ every LocalControllerServicer
    action ──▶ Thread(target=_cleanup_batch)

  message JsonResponse ──▶ string response

proto/global_controller.proto: service GlobalController
  Execute(JsonResponse) returns (JsonResponse) ──▶ declaration only
  message JsonResponse ──▶ string response
```
