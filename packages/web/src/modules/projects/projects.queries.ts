// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';

import type {
  DistributionMetric,
  MetricsAgentDetails,
  MetricsBlocks,
  MetricsDistribution,
  MetricsKpis,
  MetricsTimeseries,
} from '@canyonos/api/metrics';
import type { ProjectSummary } from '@canyonos/api/projects';
import type { RequestList, RequestStatus, RequestTrace } from '@canyonos/api/requests';
import type { FleetOverview } from '@canyonos/api/resources';

import { apiCall, forgeAuthApi } from '@/api';
import {
  dashboardPollInterval,
  projectQueryKeys,
  toParams,
} from '@/modules/projects/projects.query-cache';
import type { RangeSelection } from '@/modules/core/time-range';
import type {
  DistributionSelection,
  RequestDayBounds,
  RequestsPage,
} from '@/modules/projects/projects.metrics';

export interface RangeQuery {
  readonly range: RangeSelection;
}

export interface BucketedQuery extends RangeQuery {
  readonly time_zone: string;
}

export interface DistributionQuery extends RangeQuery {
  readonly metric: DistributionMetric;
  readonly buckets: number;
}

export type RequestsQuery = RangeQuery &
  RequestsPage &
  Partial<Pick<DistributionSelection, 'metric' | 'min' | 'max'>> &
  Partial<RequestDayBounds> & { readonly status?: RequestStatus };

export function projectDetailQueryOptions(project_id: string) {
  return queryOptions({
    queryKey: projectQueryKeys.detail(project_id),
    queryFn: () => apiCall<ProjectSummary>(() => forgeAuthApi.projects[project_id]!.get()),
    retry: false,
  });
}

export function useDeleteProject(project_id: string) {
  const query_client = useQueryClient();

  return useMutation({
    mutationFn: () =>
      apiCall<{ project_id: string }>(() => forgeAuthApi.projects[project_id]!.delete()),
    onSuccess: () =>
      query_client.invalidateQueries({ queryKey: projectQueryKeys.all, exact: true }),
  });
}

export const projectsQueryOptions = () =>
  queryOptions({
    queryKey: projectQueryKeys.all,
    queryFn: () => apiCall<ProjectSummary[]>(() => forgeAuthApi.projects.get()),
    retry: false,
  });

export const fleetOverviewQueryOptions = (query: RangeQuery) =>
  queryOptions({
    queryKey: ['resources', 'overview', query],
    queryFn: () =>
      apiCall<FleetOverview>(() =>
        forgeAuthApi.resources.overview.get({ $query: toParams(query) })
      ),
    retry: false,
  });

export const projectKpisQueryOptions = (project_id: string, query: RangeQuery) =>
  queryOptions({
    queryKey: ['projects', project_id, 'kpis', query],
    queryFn: () =>
      apiCall<MetricsKpis>(() =>
        forgeAuthApi.projects[project_id]!.metrics.kpis.get({ $query: toParams(query) })
      ),
    retry: false,
    refetchInterval: dashboardPollInterval,
  });

export const projectBlocksQueryOptions = (project_id: string, query: RangeQuery) =>
  queryOptions({
    queryKey: ['projects', project_id, 'blocks', query],
    queryFn: () =>
      apiCall<MetricsBlocks>(() =>
        forgeAuthApi.projects[project_id]!.metrics.blocks.get({ $query: toParams(query) })
      ),
    retry: false,
    refetchInterval: dashboardPollInterval,
  });

export const projectTimeseriesQueryOptions = (project_id: string, query: BucketedQuery) =>
  queryOptions({
    queryKey: ['projects', project_id, 'timeseries', query],
    queryFn: () =>
      apiCall<MetricsTimeseries>(() =>
        forgeAuthApi.projects[project_id]!.metrics.timeseries.get({ $query: toParams(query) })
      ),
    retry: false,
    refetchInterval: dashboardPollInterval,
  });

export const projectAgentQueryOptions = (
  project_id: string,
  agent_id: string,
  query: BucketedQuery
) =>
  queryOptions({
    queryKey: ['projects', project_id, 'agents', agent_id, query],
    queryFn: () =>
      apiCall<MetricsAgentDetails>(() =>
        forgeAuthApi.projects[project_id]!.metrics.agents[agent_id]!.get({
          $query: toParams(query),
        })
      ),
    retry: false,
  });

export const projectDistributionQueryOptions = (project_id: string, query: DistributionQuery) =>
  queryOptions({
    queryKey: ['projects', project_id, 'distribution', query],
    queryFn: () =>
      apiCall<MetricsDistribution>(() =>
        forgeAuthApi.projects[project_id]!.metrics.distribution.get({ $query: toParams(query) })
      ),
    retry: false,
    refetchInterval: dashboardPollInterval,
  });

export const projectRequestsQueryOptions = (project_id: string, query: RequestsQuery) =>
  queryOptions({
    queryKey: ['projects', project_id, 'requests', query],
    queryFn: () =>
      apiCall<RequestList>(() =>
        forgeAuthApi.projects[project_id]!.requests.get({ $query: toParams(query) })
      ),
    retry: false,
    refetchInterval: dashboardPollInterval,
  });

export const projectRequestTraceQueryOptions = (
  project_id: string,
  session_id: string,
  query: RangeQuery
) =>
  queryOptions({
    queryKey: ['projects', project_id, 'requests', session_id, 'trace', query],
    queryFn: () =>
      apiCall<RequestTrace>(() =>
        forgeAuthApi.projects[project_id]!.requests[session_id]!.get({ $query: toParams(query) })
      ),
    retry: false,
  });
