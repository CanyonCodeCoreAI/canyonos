// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { queryOptions } from '@tanstack/react-query';

import type { MetricsWindow } from '@canyonos/api/metrics';
import type {
  MonitoringEndpointResponse,
  MonitoringErrorSummaryResponse,
  MonitoringReplicasResponse,
  MonitoringSeriesResponse,
  MonitoringUnit,
} from '@canyonos/api/monitoring';

import { apiCall, forgeAuthApi } from '@/api';
import {
  DASHBOARD_POLL_INTERVAL_MS,
  dashboardPollInterval,
} from '@/modules/projects/projects.query-cache';

export const monitoringQueryKeys = {
  series: (project_id: string, time_window: MetricsWindow) =>
    ['projects', project_id, 'monitoring', 'series', time_window] as const,
  replicas: (project_id: string) => ['projects', project_id, 'monitoring', 'replicas'] as const,
  endpoint: (project_id: string) => ['projects', project_id, 'monitoring', 'endpoint'] as const,
  errorSummary: (project_id: string, time_window: MetricsWindow) =>
    ['projects', project_id, 'monitoring', 'errors', 'summary', time_window] as const,
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

// The exporter ships replica samples every 5s, so polling faster only re-reads the same rows.
export const replicasQueryOptions = (project_id: string) =>
  queryOptions({
    queryKey: monitoringQueryKeys.replicas(project_id),
    queryFn: () =>
      apiCall<MonitoringReplicasResponse>(() =>
        forgeAuthApi.projects[project_id]!.monitoring.replicas.get()
      ),
    refetchInterval: dashboardPollInterval,
    retry: false,
  });

// Polled so a deploy or a teardown flips the running badge without a reload.
export const endpointQueryOptions = (project_id: string) =>
  queryOptions({
    queryKey: monitoringQueryKeys.endpoint(project_id),
    queryFn: () =>
      apiCall<MonitoringEndpointResponse>(() =>
        forgeAuthApi.projects[project_id]!.monitoring.endpoint.get()
      ),
    refetchInterval: DASHBOARD_POLL_INTERVAL_MS,
    retry: false,
  });

export const errorSummaryQueryOptions = (project_id: string, time_window: MetricsWindow) =>
  queryOptions({
    queryKey: monitoringQueryKeys.errorSummary(project_id, time_window),
    queryFn: () =>
      apiCall<MonitoringErrorSummaryResponse>(() =>
        forgeAuthApi.projects[project_id]!.monitoring.errors.summary.get({
          $query: { time_window },
        })
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
