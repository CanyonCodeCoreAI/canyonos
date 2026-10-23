// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type {
  MonitoringKind,
  MonitoringResource,
  MonitoringSignal,
  MonitoringUnit,
} from './monitoring.types';

type SignalDefinition = {
  unit: MonitoringUnit;
  kind: MonitoringKind;
};

export const SIGNALS = {
  traffic: { unit: 'requests', kind: 'flow' },
  errors: { unit: 'requests', kind: 'flow' },
  latency: { unit: 'ms', kind: 'stock' },
  saturation: { unit: 'percent', kind: 'stock' },
} as const satisfies Record<MonitoringSignal, SignalDefinition>;

export const MACHINE_UTILIZATION_METRICS = {
  cpu: 'canyonos.machine.cpu.utilization',
  memory: 'canyonos.machine.memory.utilization',
  disk: 'canyonos.machine.disk.utilization',
  gpu: 'canyonos.machine.gpu.utilization',
} as const satisfies Record<MonitoringResource, string>;

export const SATURATION_METRIC = MACHINE_UTILIZATION_METRICS.cpu;

export const AGENT_UP_METRIC = 'canyonos.agent.up';

// 1 while the reconciler drains the replica: it finishes its requests but gets no new ones.
export const AGENT_DRAINING_METRIC = 'canyonos.agent.draining';

export const QUEUE_LENGTH_METRIC = 'canyonos.agent.queue.length';

export const REQUESTS_STARTED_METRIC = 'canyonos.agent.requests';

export const REQUESTS_COMPLETED_METRIC = 'canyonos.agent.requests.completed';

// Replicas report every ~5s; one missing more than this many seconds of samples is not up.
export const REPLICA_UP_SECONDS = 30;

export const RESOURCE_PROJECT_ATTRIBUTE = 'canyonos.project.id';
