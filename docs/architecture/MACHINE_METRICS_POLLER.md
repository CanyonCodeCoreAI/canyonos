# Machine metrics poller

The machine metrics poller samples one machine's CPU, memory, GPU, disk, network and
uptime and writes each sample to that machine's Redis. The Global Controller reads the
samples on its poll tick and queues them for the [OTLP exporter](OTLP_EXPORTER.md),
which sends them to the dashboard. Replicas report their own metrics separately, from
their Local Controller.

The poller runs on Docker and EC2 deploys, one per machine. On Kubernetes there is none:
see [On Kubernetes](#on-kubernetes).

| Path                                                             | What it holds                                                 |
| ---------------------------------------------------------------- | ------------------------------------------------------------- |
| `packages/core/canyonos_core/machine_metrics_poller/poller.py`   | `MachineMetricsPoller`: sections, poll loop, `main`           |
| `packages/core/canyonos_core/machine_metrics_poller/__main__.py` | `python -m canyonos_core.machine_metrics_poller`              |
| `packages/core/canyonos_core/reconciler/replicas.py`             | `start_metrics_collector`, `machine_metrics_key`              |
| `packages/core/canyonos_core/controller/global_controller.py`    | `_launch_metrics_collectors`, `_poll_machine_metrics`         |
| `packages/core/canyonos_core/reconciler/machine_provisioner.py`  | `_start_metrics_collector` for machines the reconciler starts |
| `packages/core/canyonos_core/controller/utils/gpu_metrics.py`    | `read_gpu_metrics`, through `nvidia-smi`                      |
| `packages/core/canyonos_core/otlp_exporter/metric_convert.py`    | Field to OTel metric name mapping                             |

## Where it runs

Each machine runs the poller in its own container, `canyonos-<project>-metrics-<host>`
(`metrics_container_name`, dots in the host replaced by dashes). The container runs a
CanyonOS core image with its entrypoint overridden to
`python -m canyonos_core.machine_metrics_poller`.

```text
┌─ one machine ──────────────────────────────────────────────────────────────────────────┐
│ ┌─ metrics poller container ───────────┐    ┌─ replica containers ───────────────┐     │
│ │ --pid=host      host /proc           │    │ each Local Controller writes       │     │
│ │ --network=host  localhost:<port>     │    │ controller:<host>:<port>:metrics   │     │
│ │ -v /:/host:ro   host disk usage      │    └─────────────────┬──────────────────┘     │
│ │ --gpus all      GPU, if wanted       │                      │                        │
│ └──────────────────┬───────────────────┘                      │                        │
│                    │ HSET every                               │                        │
│                    ▼ CANYONOS_POLL_INTERVAL                   │                        │
│ ┌─ machine Redis ──────────────────────┐                      │                        │
│ │ machine:<host>:metrics               │◄─────────────────────┘                        │
│ └──────────────────┬───────────────────┘                                               │
└────────────────────┼───────────────────────────────────────────────────────────────────┘
                     │ HGETALL, once per poll tick
┌─ Global Controller ┴─────────────────┐    ┌─ SQLite queue: metrics_waiting ──────┐
│ _poll_machine_metrics                ├───►│ sent on by the OTLP exporter         │
└──────────────────────────────────────┘    └──────────────────────────────────────┘
```

| Flag             | Why                                                                    |
| ---------------- | ---------------------------------------------------------------------- |
| `--pid=host`     | CPU, memory and disk IO come from the host's `/proc`                   |
| `--network=host` | Network IO is the host's; Redis is reached on `localhost:<redis_port>` |
| `-v /:/host:ro`  | Disk usage reads the host root, not the container's overlay filesystem |
| `--gpus all`     | Only when a GPU is wanted: it fails without the NVIDIA runtime         |
| `--restart`      | `unless-stopped`, so Docker restarts a poller that exits               |

## How it starts

Two places start pollers, each from a different image:

| Machine                             | Started by                                    | Image                       | GPU requested when                      |
| ----------------------------------- | --------------------------------------------- | --------------------------- | --------------------------------------- |
| The Global Controller's own machine | `GlobalController._launch_metrics_collectors` | `CANYONOS_CONTROLLER_IMAGE` | any agent sets `resources.gpu`          |
| Each machine the reconciler starts  | `MachineProvisioner._start_metrics_collector` | `CANYONOS_COLLECTOR_IMAGE`  | the machine was started for a GPU agent |

The Global Controller starts its own machine's poller at startup
(`CanyonOrchestrator.start_support_services`), right after that machine's Redis. The
reconciler starts each other machine's poller in `_start_machine`, right after the
machine's Redis and before the machine's `private_host` is saved. Other machines use
the official release image of the CLI's version, because `CANYONOS_CONTROLLER_IMAGE`
may be a dev image built on this machine, which they have no registry to pull from.
The CLI sets both variables on the Global Controller container.

Both go through `start_metrics_collector`, which:

1. Reuses the container if one of that name is already running.
2. Otherwise removes any stopped container of that name, then runs a new one, locally
   or over SSH.
3. Returns the container name, or `None` when the start failed. A failure is logged,
   never raised: a machine without a poller still runs replicas.

Without its image variable, each caller logs that machine metrics will be missing and
starts nothing. At startup the Global Controller also removes a stopped poller container
left on its machine by an earlier run (`_remove_stale_containers`). At teardown, or when
initialization fails, it removes the poller it started (`_stop_metrics_collectors`). It
does not track the pollers on other machines.

## Configuration

`start_metrics_collector` sets these on the container. `main` reads them, with the
defaults shown for a poller run by hand.

| Variable                  | Set to                                                                                                               | Default when unset                           |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `CANYONOS_REDIS_HOST`     | `localhost`                                                                                                          | `localhost`                                  |
| `CANYONOS_REDIS_PORT`     | the machine's Redis port                                                                                             | `6379`                                       |
| `CANYONOS_REDIS_PASSWORD` | the project's Redis password: by name from the Global Controller's environment on its own machine, by value over SSH | none                                         |
| `CANYONOS_METRICS_KEY`    | `machine:<host>:metrics`                                                                                             | `machine:<CANYONOS_AGENT_HOST>:metrics`      |
| `CANYONOS_POLL_INTERVAL`  | workflow config `poll_interval`, default `5`                                                                         | `1.0` seconds                                |
| `CANYONOS_AGENT_HOST`     | not set                                                                                                              | `localhost`; used only when the key is unset |

The Global Controller's own machine uses the host name `localhost` in its key.

## Poll loop

`MachineMetricsPoller.run` loops until `SIGTERM` or `SIGINT`:

1. `_collect` stamps `observed_at` with the current time, so a sample carries its
   measurement time rather than the time the Global Controller read it.
2. It calls each section below. Each is guarded on its own, so a failing source (no
   GPU, no `/proc/pressure`) is logged and the rest of the sample is still written.
3. `_write_once` writes the whole sample with one `HSET` to the metrics key. A failed
   write is logged and the loop goes on.
4. It sleeps for the interval in 0.5 s slices, so a signal stops it promptly.

The constructor primes `psutil.cpu_percent`, since psutil measures CPU use between two
calls. Disk and network rates are computed from the change in cumulative counters
since the previous sample, each with its own timestamp, and are 0 on the first sample.

## Fields

Every value in the hash is a string. `metric_convert.py` maps each field to an OTel
gauge on a resource named `canyonos-machine-<host>`.

| Section     | Field                        | Source                                                       | OTel metric                                              | Unit          |
| ----------- | ---------------------------- | ------------------------------------------------------------ | -------------------------------------------------------- | ------------- |
| (sample)    | `observed_at`                | `time.time()` at collection                                  | sample timestamp                                         | s             |
| `_cpu`      | `cpu_percent`                | `psutil.cpu_percent`                                         | `canyonos.machine.cpu.utilization`                       | `%`           |
| `_cpu`      | `cpu_available_percent`      | `100 - cpu_percent`                                          | `canyonos.machine.cpu.available`                         | `%`           |
| `_cpu`      | `cpu_pressure`               | `/proc/pressure/cpu` `some avg10`, else load average / cores | `canyonos.machine.cpu.pressure`                          | `1`           |
| `_memory`   | `memory_percent`             | `psutil.virtual_memory`                                      | `canyonos.machine.memory.utilization`                    | `%`           |
| `_memory`   | `memory_used_bytes`          | `psutil.virtual_memory`                                      | `canyonos.machine.memory.used`                           | `By`          |
| `_memory`   | `memory_available_bytes`     | `psutil.virtual_memory`                                      | `canyonos.machine.memory.available`                      | `By`          |
| `_memory`   | `memory_pressure`            | `/proc/pressure/memory` `some avg10`, else 0                 | `canyonos.machine.memory.pressure`                       | `1`           |
| `_gpu`      | `gpu_percent`                | `read_gpu_metrics`, first GPU; 0 without `nvidia-smi`        | `canyonos.machine.gpu.utilization`                       | `%`           |
| `_gpu`      | `gpu_memory_used_bytes`      | `read_gpu_metrics`                                           | `canyonos.machine.gpu.memory.used`                       | `By`          |
| `_gpu`      | `gpu_memory_available_bytes` | `read_gpu_metrics`                                           | `canyonos.machine.gpu.memory.available`                  | `By`          |
| `_disk`     | `disk_percent`               | `psutil.disk_usage("/host")`                                 | `canyonos.machine.disk.utilization`                      | `%`           |
| `_disk`     | `disk_free_bytes`            | `psutil.disk_usage("/host")`                                 | `canyonos.machine.disk.free`                             | `By`          |
| `_disk`     | `uptime_seconds`             | `time.time() - psutil.boot_time()`                           | `canyonos.machine.uptime`                                | `s`           |
| `_disk`     | `disk_read_bytes_per_sec`    | `psutil.disk_io_counters`, rate between samples              | `canyonos.machine.disk.read`                             | `By/s`        |
| `_disk`     | `disk_write_bytes_per_sec`   | `psutil.disk_io_counters`, rate between samples              | `canyonos.machine.disk.write`                            | `By/s`        |
| `_network`  | `network_rx_bytes_per_sec`   | `psutil.net_io_counters`, rate between samples               | `canyonos.machine.network.rx`                            | `By/s`        |
| `_network`  | `network_tx_bytes_per_sec`   | `psutil.net_io_counters`, rate between samples               | `canyonos.machine.network.tx`                            | `By/s`        |
| `_capacity` | `machine_capacity`           | JSON: `cpu_count`, `memory_total_bytes`, `disk_total_bytes`  | `canyonos.machine.{cpu.count, memory.total, disk.total}` | `{cpu}`, `By` |

When `/host` does not exist, as when the poller runs outside its container, disk usage
reads `/`.

## To the dashboard

`CanyonOrchestrator.poll_machine_metrics` calls `_poll_machine_metrics` once per Global
Controller poll tick, outside the per-replica loop, so a machine with many replicas is
read once. It:

1. Lists the hosts: `localhost`, plus the `private_host` of every `machine_record:*`
   that is not this machine, whether or not replicas run there.
2. Reads each host's `machine:<host>:metrics` hash from that host's Redis, one host
   after another.
3. Turns each non-empty hash into a row `{kind: machine, host, project_id, metrics}`.
4. Queues the rows in `metrics_waiting` with `otel_writer.metric_write_rows`.

A hash not written yet or an unreachable Redis is skipped with a warning.

## On Kubernetes

The Kubernetes orchestrator starts no poller, since a replica's machine there is its
pod. `KubernetesOrchestrator.poll_machine_metrics` reads pod usage from the cluster's
metrics API (metrics-server) and `pod_machine_rows` (`kubernetes/api.py`) turns each
project pod into a `machine` row with the same field names: `memory_used_bytes` always,
and the CPU and memory percentages as a share of the pod's limits when every container
has one. Without the metrics API it warns once and records no rows until the API
answers again.

## Failure handling

| Failure                              | Effect                                                       |
| ------------------------------------ | ------------------------------------------------------------ |
| Image variable unset                 | Error or warning logged; that machine has no machine metrics |
| `docker run` fails                   | Warning logged; replicas still run                           |
| One section raises                   | Warning logged; the other fields are written                 |
| Redis write fails                    | Warning logged; the next tick tries again                    |
| Poller process exits                 | Docker restarts it (`--restart unless-stopped`)              |
| Global Controller cannot read a host | Warning logged; that host has no row for the tick            |

The hash is overwritten on every tick and has no expiry, so after a poller stops the
Global Controller keeps reading its last sample. The queue row's `sample_id` includes
`observed_at`, so rereading the same sample updates one row instead of adding another.

## Changing it

- New field: add it to a section in `poller.py`, then to `_MACHINE_GAUGES` in
  `otlp_exporter/metric_convert.py`, or it is stored but never exported.
- Launch flags and environment: `start_metrics_collector` in `reconciler/replicas.py`;
  both launchers share it.
