// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { queryOptions } from '@tanstack/react-query';

import type {
  MonitoringEndpointResponse,
  MonitoringErrorSummaryResponse,
  MonitoringLlmCallsResponse,
  MonitoringLogSourcesResponse,
  MonitoringLogsResponse,
  MonitoringReplicasResponse,
  MonitoringResourceUtilizationResponse,
  MonitoringSeriesResponse,
  MonitoringTracesResponse,
  MonitoringUnit,
} from '@canyonos/api/monitoring';

import { apiCall, forgeAuthApi } from '@/api';
import {
  DASHBOARD_POLL_INTERVAL_MS,
  dashboardPollInterval,
  toParams,
} from '@/modules/projects/projects.query-cache';
import type { BucketedQuery, RangeQuery } from '@/modules/projects/projects.queries';

export interface ListQuery extends RangeQuery {
  readonly limit: number;
}

export interface LogsQuery extends ListQuery {
  readonly errors_only: boolean;
  readonly agent?: string;
  readonly replica?: string;
}

export const monitoringSeriesQueryOptions = (project_id: string, query: BucketedQuery) =>
  queryOptions({
    queryKey: ['projects', project_id, 'monitoring', 'series', query],
    queryFn: () =>
      apiCall<MonitoringSeriesResponse>(() =>
        forgeAuthApi.projects[project_id]!.monitoring.series.get({ $query: toParams(query) })
      ),
    retry: false,
  });

export const resourcesQueryOptions = (project_id: string, query: BucketedQuery) =>
  queryOptions({
    queryKey: ['projects', project_id, 'monitoring', 'resources', query],
    queryFn: () =>
      apiCall<MonitoringResourceUtilizationResponse>(() =>
        forgeAuthApi.projects[project_id]!.monitoring.resources.get({ $query: toParams(query) })
      ),
    retry: false,
  });

export const tracesQueryOptions = (project_id: string, query: ListQuery) =>
  queryOptions({
    queryKey: ['projects', project_id, 'monitoring', 'traces', query],
    queryFn: () =>
      apiCall<MonitoringTracesResponse>(() =>
        forgeAuthApi.projects[project_id]!.monitoring.traces.get({ $query: toParams(query) })
      ),
    retry: false,
  });

export const llmCallsQueryOptions = (project_id: string, query: ListQuery) =>
  queryOptions({
    queryKey: ['projects', project_id, 'monitoring', 'llm', query],
    queryFn: () =>
      apiCall<MonitoringLlmCallsResponse>(() =>
        forgeAuthApi.projects[project_id]!.monitoring.llm.get({ $query: toParams(query) })
      ),
    retry: false,
  });

export const logsQueryOptions = (project_id: string, query: LogsQuery) =>
  queryOptions({
    queryKey: ['projects', project_id, 'monitoring', 'logs', query],
    queryFn: () =>
      apiCall<MonitoringLogsResponse>(() =>
        forgeAuthApi.projects[project_id]!.monitoring.logs.get({ $query: toParams(query) })
      ),
    retry: false,
  });

export const logSourcesQueryOptions = (project_id: string, query: RangeQuery) =>
  queryOptions({
    queryKey: ['projects', project_id, 'monitoring', 'log-sources', query],
    queryFn: () =>
      apiCall<MonitoringLogSourcesResponse>(() =>
        forgeAuthApi.projects[project_id]!.monitoring.logs.sources.get({ $query: toParams(query) })
      ),
    retry: false,
  });

// The exporter ships replica samples every 5s, so polling faster only re-reads the same rows.
export const replicasQueryOptions = (project_id: string) =>
  queryOptions({
    queryKey: ['projects', project_id, 'monitoring', 'replicas'],
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
    queryKey: ['projects', project_id, 'monitoring', 'endpoint'],
    queryFn: () =>
      apiCall<MonitoringEndpointResponse>(() =>
        forgeAuthApi.projects[project_id]!.monitoring.endpoint.get()
      ),
    refetchInterval: DASHBOARD_POLL_INTERVAL_MS,
    retry: false,
  });

export const errorSummaryQueryOptions = (project_id: string, query: RangeQuery) =>
  queryOptions({
    queryKey: ['projects', project_id, 'monitoring', 'errors', 'summary', query],
    queryFn: () =>
      apiCall<MonitoringErrorSummaryResponse>(() =>
        forgeAuthApi.projects[project_id]!.monitoring.errors.summary.get({
          $query: toParams(query),
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
