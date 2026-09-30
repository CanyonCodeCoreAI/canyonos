# Controller — Architecture

## Runtime layout

```
CLI host:         ──▶          8000
                         ┌───────┴──── canyonos-global-controller ────────┐
                         │ canyonos_core.server                           │
                         │ POST /deploy ──▶ canyonos_core.cli deploy      │
                         │                         │                      │
                         │                  GlobalController             │
                         │                    ├─ reconciler               │
                         │                    └─ otel_exporter             │
                         └────────────────────────┬───────────────────────┘
                                                  │ 
┌──────────────────────────── one machine ────────┼───────────────────────────┐
│ canyonos-redis-<host> ◀── RedisClient ──────────┘  redis_port (6379)        │
│        ▲                                                                     │
│        ├── agent replica: LocalController + agent code                      │
│        │      gRPC [::]:50051; host publication <host>:<host_port>           │
│        │      routing_endpoint_for ──▶ <runtime_id>:50051 (local)            │
│        │      LLM gateway ──▶ 127.0.0.1:8081                                   │
│        │                                                                     │
│        ├── workflow replica: LocalController + deploy(workflow_fn)           │
│        │      host <api_port> ──▶ container 8080                             │
│        │                                                                     │
│        └── canyonos-metrics-<host>                                           │
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
                    │    ├─ resolve_env_file
                    │    └─ RedisClient
                    ├─ _cleanup_stale_containers
                    ├─ _launch_redis_containers
                    ├─ _launch_metrics_collectors
                    ├─ _apply_config
                    │    ├─ write_config_specs
                    │    ├─ _apply_configured_replicas
                    │    ├─ _load_and_write_policies
                    │    └─ _write_identity
                    ├─ schema.init_db
                    ├─ ProcessSupervisor.start_all
                    │    ├─ reconciler
                    │    └─ otel_exporter
                    └─ _cleanup_loop ──▶ _wait_for_healthy ──▶ run
                                                               └─ _poll_controllers
```

## Local Controller startup

```
agent image                              workflow image
python local_controller.py --port 50051  python workflow_launcher.py
             │                                      ├─ LocalController(
             │                                      │    publish_ready=False)
             │                                      ├─ threading.Thread(
             │                                      │    target=controller.run)
             │                                      ├─ mark_ready_when_serving
             │                                      └─ exec(<workflow_file>)
             └──────────────────┬─────────────────────────────────────────
                                ▼
                      LocalController.__init__
                                ├─ start_server ──▶ LocalControllerServicer
                                │                    └─ queue.Queue()
                                ├─ RedisClient(CANYONOS_REDIS_HOST,
                                │              CANYONOS_REDIS_PORT)
                                ├─ _start_llm_gateway ──▶ 127.0.0.1:8081
                                │                         └─ canyonos_core.llm_gateway
                                ├─ GET controller:<host>:<port>:agent_id
                                ├─ SET status = initializing
                                ├─ _metrics_loop
                                ├─ _load_agent
                                └─ mark_ready ──▶ status = healthy
```

## Workflow serving

```
workflow_launcher.py ──▶ exec(<workflow_file>)
                              └─▶ deploy(workflow_fn, port=8080, host="0.0.0.0")
                                         └─ Flask
                         ┌────────────────┴────────────────┐
                         ▼                                 ▼
              POST /<workflow_fn_name>          GET /status/<request_id>
                         │                                 ├─ GET status
                         ├─ kwargs.pop("_context", {})     ├─ done  ──▶ GET result
                         ├─ uuid.uuid4().hex               ├─ error ──▶ GET error
                         ├─ SET status = pending           └─ missing ──▶ 404
                         ├─ threading.Thread(target=_execute_workflow)
                         └─ 202 {"request_id": <id>}
                                  │
                                  ▼
                           _execute_workflow
                                  ├─ status = running
                                  ├─ SET context
                                  ├─ set_request_id
                                  ├─ workflow_fn(**kwargs) ──▶ _resolved
                                  ├─ result + status = done
                                  └─ error + status = error
                                           ├─ SADD request:completed
                                           └─ _expire_request_keys (300s)
```

## Request lifecycle

```
workflow_fn ──▶ generated agent stub ──▶ Future.__init__
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
          routing_table:endpoints ──▶ _resolve_endpoint ◀── routing_table:stateful
                                                               │
                         ┌─────────────────────────────────────┴──────────────┐
                         │ endpoint == _my_endpoint                         │ remote
                         ▼                                                  ▼
             ThreadPoolExecutor.submit                              _forward_request
                         │                                          Execute
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
     └─▶ request:<request_id>:result + status = done
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

request status = done | error ──▶ SADD request:completed
                                         │
                                         ▼
                            GlobalController._trigger_cleanup
                              ├─ SMEMBERS on every node Redis
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
             otel:destinations, request:completed
  reads  ◀── agent_instance:*, agent:<name>:instances,
             controller:<host>:<port>:status,
             controller:<host>:<port>:metrics, machine:<host>:metrics,
             future:*, agent:<agent_id>:instance_type, request:completed

LocalController / LocalControllerServicer
  writes ──▶ controller:<host>:<port>:status,
             controller:<host>:<port>:metrics,
             request:<request_id>:context, request:<request_id>:futures,
             request:<request_id>:cleanup_lock, future:<future_id>,
             future:<future_id>:children, future:<future_id>:consumers,
             affinity:<request_id>, execute:<endpoint>:<future_id>:accepted
  reads  ◀── controller:<host>:<port>:agent_id,
             routing_table:endpoints, routing_table:stateful, policy:rules,
             request:<request_id>:context, request:<request_id>:futures,
             future:<future_id>, future:<future_id>:consumers,
             affinity:<request_id>

deploy / Future
  writes ──▶ request:<request_id>:status, request:<request_id>:result,
             request:<request_id>:error, request:<request_id>:context,
             request:<request_id>:futures, request:completed,
             future:<future_id>, future:<future_id>:consumers
  reads  ◀── request:<request_id>:status, request:<request_id>:result,
             request:<request_id>:error, future:<future_id>

reconciler
  writes ──▶ agent_instance:*, agent:<name>:instances,
             routing_table:services, routing_table:endpoints,
             routing_table:stateful
```

## gRPC services

```
proto/local_controler.proto: service LocalController
  Execute(JsonResponse) returns (JsonResponse)
    Future._submit_request ───────────▶ local LocalControllerServicer
    LocalController._forward_request ─▶ remote LocalControllerServicer
    action ──▶ request_queue.put(request.resonse)

  WriteResult(JsonResponse) returns (JsonResponse)
    LocalController._send_result_callback ──▶ origin / consumer
    Future._notify_consumers ───────────────▶ consumer
    action ──▶ HSET future:<future_id> ──▶ _fan_out_to_consumers

  Cleanup(JsonResponse) returns (JsonResponse)
    GlobalController._trigger_cleanup ──▶ every LocalControllerServicer
    action ──▶ Thread(target=_cleanup_batch)

  message JsonResponse ──▶ string resonse

proto/global_controller.proto: service GlobalController
  Execute(JsonResponse) returns (JsonResponse) ──▶ declaration only
  message JsonResponse ──▶ string resonse
```
