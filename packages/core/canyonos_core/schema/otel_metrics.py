# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""The metrics CanyonOS records, as OTel metric name to unit."""

SCOPE_NAME = "canyonos.metrics"

# Per-machine samples; all point-in-time gauges.
MACHINE_GAUGES = {
    "canyonos.machine.cpu.utilization": "%",
    "canyonos.machine.cpu.available": "%",
    "canyonos.machine.cpu.pressure": "1",
    "canyonos.machine.memory.utilization": "%",
    "canyonos.machine.memory.used": "By",
    "canyonos.machine.memory.available": "By",
    "canyonos.machine.memory.pressure": "1",
    "canyonos.machine.gpu.utilization": "%",
    "canyonos.machine.gpu.memory.used": "By",
    "canyonos.machine.gpu.memory.available": "By",
    "canyonos.machine.disk.utilization": "%",
    "canyonos.machine.disk.free": "By",
    "canyonos.machine.disk.read": "By/s",
    "canyonos.machine.disk.write": "By/s",
    "canyonos.machine.network.rx": "By/s",
    "canyonos.machine.network.tx": "By/s",
    "canyonos.machine.uptime": "s",
    "canyonos.machine.cpu.count": "{cpu}",
    "canyonos.machine.memory.total": "By",
    "canyonos.machine.disk.total": "By",
}

# Per-replica samples: point-in-time gauges, and counters that only ever grow.
AGENT_GAUGES = {
    "canyonos.agent.queue.length": "{item}",
    "canyonos.agent.draining": "1",
    "canyonos.agent.concurrency.limit": "{request}",
    "canyonos.agent.memory.used": "By",
    "canyonos.agent.memory.limit": "By",
    "canyonos.agent.up": "1",
}
AGENT_SUMS = {
    "canyonos.agent.requests": "{request}",
    "canyonos.agent.requests.completed": "{request}",
    "canyonos.agent.failures": "{failure}",
}
