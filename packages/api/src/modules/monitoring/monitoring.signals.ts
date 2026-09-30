import type { MonitoringKind, MonitoringSignal, MonitoringUnit } from './monitoring.types';

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

export const SATURATION_METRIC = 'canyonos.machine.cpu.utilization';

export const MACHINE_UTILIZATION_METRICS = {
  cpu: 'canyonos.machine.cpu.utilization',
  memory: 'canyonos.machine.memory.utilization',
  disk: 'canyonos.machine.disk.utilization',
  gpu: 'canyonos.machine.gpu.utilization',
} as const;

export type MonitoringResource = keyof typeof MACHINE_UTILIZATION_METRICS;

export const RESOURCE_PROJECT_ATTRIBUTE = 'canyonos.project.id';
