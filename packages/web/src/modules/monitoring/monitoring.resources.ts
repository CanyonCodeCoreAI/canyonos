import type { MonitoringResource } from '@canyonos/api/monitoring';

import { PALETTE } from '@/modules/core/navigation/navigation';

export const RESOURCE_COLORS: Record<MonitoringResource, string> = {
  cpu: PALETTE.steel,
  memory: '#7b2d3f',
  disk: '#c9a227',
  gpu: PALETTE.emerald,
};

export const RESOURCE_LABELS: Record<MonitoringResource, string> = {
  cpu: 'CPU',
  memory: 'Memory',
  disk: 'Disk',
  gpu: 'GPU',
};

export const RESOURCE_ORDER: readonly MonitoringResource[] = ['cpu', 'memory', 'disk', 'gpu'];
