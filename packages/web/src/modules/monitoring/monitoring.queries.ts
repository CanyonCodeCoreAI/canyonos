import { queryOptions } from '@tanstack/react-query';

import type { MetricsWindow } from '@canyonos/api/metrics';
import type { MonitoringSeriesResponse, MonitoringUnit } from '@canyonos/api/monitoring';

import { apiCall, forgeAuthApi } from '@/api';

export const monitoringQueryKeys = {
  series: (project_id: string, time_window: MetricsWindow) =>
    ['projects', project_id, 'monitoring', 'series', time_window] as const,
};

export const monitoringSeriesQueryOptions = (project_id: string, time_window: MetricsWindow) =>
  queryOptions({
    queryKey: monitoringQueryKeys.series(project_id, time_window),
    queryFn: () =>
      apiCall<MonitoringSeriesResponse>(() =>
        forgeAuthApi.projects[project_id]!.monitoring.series.get({ $query: { time_window } })
      ),
    retry: false,
  });

export const SIGNAL_LABELS = {
  traffic: 'Traffic',
  errors: 'Errors',
  latency: 'Latency (p95)',
  saturation: 'Saturation (CPU)',
} as const;

export const UNIT_AXIS_LABELS: Record<MonitoringUnit, string> = {
  requests: 'Requests',
  ms: 'Latency (ms)',
  percent: 'Utilization (%)',
};

export function formatSignalValue(value: number, unit: MonitoringUnit): string {
  switch (unit) {
    case 'requests':
      return value.toLocaleString();
    case 'ms':
      return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`;
    case 'percent':
      return `${Math.round(value)}%`;
  }
}

export function formatBucketLabel(start_at: string, bucket_seconds: number): string {
  const at = new Date(start_at);
  return bucket_seconds >= 86_400
    ? at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : at.toLocaleTimeString(undefined, { hour: 'numeric' });
}
