# Machine Metrics Poller — Architecture

## Where it runs

```
┌─────────────────────────────────── one host ───────────────────────────────────┐
│                                                                                 │
│   ┌──────────────────────────────┐        ┌──────────────────────────────────┐  │
│   │ canyonos-metrics-<host>      │        │ agent replica containers         │  │
│   │ (controller image,           │        │  Local Controller writes its own │  │
│   │  entrypoint overridden)      │        │  per-instance metrics hash       │  │
│   │                              │        └──────────────────────────────────┘  │
│   │ python -m canyonos_core.     │                                              │
│   │   machine_metrics_poller     │                                              │
│   │                              │                                              │
│   │ --pid=host      ─▶ host /proc (cpu, memory, disk io, network io)            │
│   │ --network=host  ─▶ localhost:<redis_port>                                   │
│   │ -v /:/host:ro   ─▶ /host disk usage                                         │
│   │ --gpus all      ─▶ GPU (only if an agent on this host asks for one)         │
│   └──────────────┬───────────────┘                                              │
│                  │ HSET every poll_interval                                     │
│                  ▼                                                              │
│   ┌──────────────────────────────┐                                              │
│   │ node Redis                   │                                              │
│   │ machine:<host>:metrics       │                                              │
│   └──────────────▲───────────────┘                                              │
└──────────────────┼──────────────────────────────────────────────────────────────┘
                   │ HGETALL
┌──────────────────┴───────────────┐
│ Global Controller                │
│ _poll_machine_metrics            │
└──────────────────────────────────┘
```

## Launch

```
Global Controller startup
     │
     ▼
_launch_metrics_collectors
     │
     ├─ CANYONOS_CONTROLLER_IMAGE unset? ──▶ log error, no collectors
     │
     ├─ unique hosts from every agent's replica placements
     │     └─ gpu = any agent on the host has resources.gpu
     │
     └─ per host (local docker or SSH)
           │
           ├─ docker inspect canyonos-metrics-<host>
           │     └─ running? ──▶ reuse
           │
           ├─ docker rm -f  (stale container)
           │
           └─ docker run -d --restart unless-stopped
                 -e CANYONOS_REDIS_HOST=localhost
                 -e CANYONOS_REDIS_PORT=<redis_port>
                 -e CANYONOS_METRICS_KEY=machine:<host>:metrics
                 -e CANYONOS_POLL_INTERVAL=<poll_interval>
```

## Poll loop

```
main()
  │  env ──▶ RedisClient, metrics key, interval
  │  SIGTERM / SIGINT ──▶ stop()
  ▼
run()
  │
  └─▶ while running
         │
         ├─▶ _collect()
         │     observed_at = now
         │     ├─ _cpu       ─┐
         │     ├─ _memory     │
         │     ├─ _gpu        │  each section guarded:
         │     ├─ _disk       │  one failure is logged,
         │     ├─ _network    │  the rest still reported
         │     └─ _capacity  ─┘
         │
         ├─▶ HSET machine:<host>:metrics  (failure logged, loop continues)
         │
         └─▶ sleep interval in 0.5s slices (so SIGTERM stays responsive)
```

## Sources

```
_cpu        psutil.cpu_percent ────────────────────▶ cpu_percent, cpu_available_percent
            /proc/pressure/cpu (or load average) ──▶ cpu_pressure

_memory     psutil.virtual_memory ─────────────────▶ memory_percent, _used_bytes, _available_bytes
            /proc/pressure/memory (or 0) ──────────▶ memory_pressure

_gpu        read_gpu_metrics ──────────────────────▶ gpu_percent, gpu_memory_used/available_bytes

_disk       psutil.disk_usage(/host) ──────────────▶ disk_percent, disk_free_bytes
            psutil.boot_time ──────────────────────▶ uptime_seconds
            psutil.disk_io_counters ─┐
                                     ├─ _io_rate ──▶ disk_read/write_bytes_per_sec
_network    psutil.net_io_counters ──┘             ▶ network_rx/tx_bytes_per_sec

_capacity   cpu_count, memory total, disk total ───▶ machine_capacity (JSON)
```

## To the dashboard

```
machine:<host>:metrics  (node Redis)
          │
          │ Global Controller poll tick, hosts read in parallel
          ▼
_poll_machine_metrics ──▶ row { kind: machine, host, project_id, metrics }
          │
          ▼
otel_writer.metric_write_rows ──▶ metrics_waiting ──▶ OTLP exporter ──▶ dashboard
```
