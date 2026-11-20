# Machine metrics poller

The machine metrics poller samples one machine's CPU, memory, GPU, disk, network and uptime for the dashboard. Replicas report their own metrics from their Local Controller; this one is about the machine underneath them.

It is a container that looks at the host, not at itself. Docker and EC2 deploys run one per machine.

## How it fits

```text
┌─ one machine ──────────────────────────────────────────┐
│ ┌─ poller container ────────┐                          │
│ │ --pid=host   host /proc   │                          │
│ │ --network=host            │                          │
│ │ -v /:/host:ro  host disk  │                          │
│ │ --gpus all  if GPU wanted │                          │
│ └─────────────┬─────────────┘                          │
│               │ HSET each poll interval                │
│               ▼                                        │
│ ┌─ machine Redis ───────────┐                          │
│ │ machine:<host>:metrics    │                          │
│ └─────────────┬─────────────┘                          │
└───────────────┼────────────────────────────────────────┘
                │ HGETALL, once per poll tick
                ▼
        Global Controller ──► dashboard's Postgres
```

The poller sees the host because it shares the host's PID and network namespaces and mounts the host root read-only. Without that it would measure its own container.

- It samples every `poll_interval` seconds from `workflow_group.yaml` (default 5).
- If one source fails (no GPU, no `/proc/pressure`), it logs the failure and still writes the rest of the sample.
- Each sample overwrites one hash in the machine's Redis. The Global Controller reads it on its poll tick, stores it in the dashboard's Postgres and hands it to the [OTel Collector](OTEL_COLLECTOR.md).

Each field is stored under its OTel metric name and becomes a gauge on the resource `canyonos-machine-<host>`. `MACHINE_GAUGES` in `schema/otel_metrics.py` is the list.

## How it starts

Two launchers start pollers, each from a different image:

| Machine                             | Started by                                    | Image                       |
| ----------------------------------- | --------------------------------------------- | --------------------------- |
| The Global Controller's own machine | The Global Controller, at startup              | `CANYONOS_CONTROLLER_IMAGE` |
| Each machine the reconciler starts  | The machine provisioner, after a machine starts | `CANYONOS_COLLECTOR_IMAGE`  |

Other machines use the official release image because `CANYONOS_CONTROLLER_IMAGE` may be a dev image built on this machine, which they cannot pull. A failed start is logged and never raised: a machine without a poller still runs replicas.

## On Kubernetes

There is no poller. A replica's machine is its pod, so `KubernetesOrchestrator.poll_machine_metrics` reads pod usage from the cluster's metrics API and writes `machine` rows with the same field names. Without the metrics API it warns once and records nothing.

## Code

| Path                                                            | What it holds                                           |
| --------------------------------------------------------------- | ------------------------------------------------------- |
| `packages/core/canyonos_core/machine_metrics_poller/poller.py`  | Sampling and the write loop                             |
| `packages/core/canyonos_core/reconciler/replicas.py`            | `start_metrics_collector`: the `docker run` flags       |
| `packages/core/canyonos_core/controller/global_controller.py`   | Starts its own poller; reads every machine's hash       |
| `packages/core/canyonos_core/reconciler/machine_provisioner.py` | Starts the poller on machines the reconciler provisions |
| `packages/core/canyonos_core/schema/otel_metrics.py`            | `MACHINE_GAUGES`: OTel metric to unit                   |

## Changing it

- New field: add it in `poller.py` under its OTel metric name, then to `MACHINE_GAUGES`, or it is stored but never exported.
- Launch flags and environment: `start_metrics_collector` in `reconciler/replicas.py`. Both launchers share it.
