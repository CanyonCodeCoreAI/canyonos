# Machine Metrics Poller

This process is responsible for gathering machine-level information about the device it is running on.
This process will write the data to the machine:{host}:metrics field in the Redis container on the machine, which will get polled by the Global Controller and written to the dashboard's Postgres.

Every machine runs one. The Global Controller starts this machine's from its own image (`CANYONOS_CONTROLLER_IMAGE`); the reconciler starts each other machine's, right after its Redis, from the official release image (`CANYONOS_COLLECTOR_IMAGE`), since a dev image built here is in no registry those machines can pull from.

Below is the data that this process collects:

| Metric | Unit |
| --- | --- |
| `canyonos.machine.cpu.utilization` | `%` |
| `canyonos.machine.cpu.available` | `%` |
| `canyonos.machine.cpu.pressure` | `1` |
| `canyonos.machine.memory.utilization` | `%` |
| `canyonos.machine.memory.used` | `By` |
| `canyonos.machine.memory.available` | `By` |
| `canyonos.machine.memory.pressure` | `1` |
| `canyonos.machine.gpu.utilization` | `%` |
| `canyonos.machine.gpu.memory.used` | `By` |
| `canyonos.machine.gpu.memory.available` | `By` |
| `canyonos.machine.disk.utilization` | `%` |
| `canyonos.machine.disk.free` | `By` |
| `canyonos.machine.disk.read` | `By/s` |
| `canyonos.machine.disk.write` | `By/s` |
| `canyonos.machine.network.rx` | `By/s` |
| `canyonos.machine.network.tx` | `By/s` |
| `canyonos.machine.uptime` | `s` |
| `canyonos.machine.cpu.count` | `{cpu}` |
| `canyonos.machine.memory.total` | `By` |
| `canyonos.machine.disk.total` | `By` |
