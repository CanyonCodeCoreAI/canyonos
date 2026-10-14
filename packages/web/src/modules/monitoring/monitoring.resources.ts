// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { MonitoringResource } from '@canyonos/api/monitoring';

export const RESOURCE_COLORS: Record<MonitoringResource, string> = {
  cpu: 'var(--resource-cpu)',
  memory: 'var(--resource-memory)',
  disk: 'var(--resource-disk)',
  gpu: 'var(--resource-gpu)',
};

export const RESOURCE_LABELS: Record<MonitoringResource, string> = {
  cpu: 'CPU',
  memory: 'Memory',
  disk: 'Disk',
  gpu: 'GPU',
};

export const RESOURCE_ORDER: readonly MonitoringResource[] = ['cpu', 'memory', 'disk', 'gpu'];
