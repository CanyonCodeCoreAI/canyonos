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
import type { RequestList, RequestStatus, RequestTrace } from '@canyonos/api/requests';
import type { FleetOverview } from '@canyonos/api/resources';
import type { WorkflowDeleted, WorkflowSummary } from '@canyonos/api/workflows';

import { apiCall, forgeAuthApi } from '@/api';
import {
  dashboardPollInterval,
  toParams,
  workflowQueryKeys,
} from '@/modules/workflows/workflows.query-cache';
import type { RangeSelection } from '@/modules/core/time-range';
import type {
  DistributionSelection,
  RequestDayBounds,
  RequestsPage,
} from '@/modules/workflows/workflows.metrics';

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

export function workflowDetailQueryOptions(workflow_id: string) {
  return queryOptions({
    queryKey: workflowQueryKeys.detail(workflow_id),
    queryFn: () => apiCall<WorkflowSummary>(() => forgeAuthApi.workflows[workflow_id]!.get()),
    retry: false,
  });
}

export function useDeleteWorkflow(workflow_id: string) {
  const query_client = useQueryClient();

  return useMutation({
    mutationFn: () => apiCall<WorkflowDeleted>(() => forgeAuthApi.workflows[workflow_id]!.delete()),
    onSuccess: () =>
      query_client.invalidateQueries({ queryKey: workflowQueryKeys.all, exact: true }),
  });
}

export const workflowsQueryOptions = () =>
  queryOptions({
    queryKey: workflowQueryKeys.all,
    queryFn: () => apiCall<WorkflowSummary[]>(() => forgeAuthApi.workflows.get()),
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

export const workflowKpisQueryOptions = (workflow_id: string, query: RangeQuery) =>
  queryOptions({
    queryKey: ['workflows', workflow_id, 'kpis', query],
    queryFn: () =>
      apiCall<MetricsKpis>(() =>
        forgeAuthApi.workflows[workflow_id]!.metrics.kpis.get({ $query: toParams(query) })
      ),
    retry: false,
    refetchInterval: dashboardPollInterval,
  });

export const workflowBlocksQueryOptions = (workflow_id: string, query: RangeQuery) =>
  queryOptions({
    queryKey: ['workflows', workflow_id, 'blocks', query],
    queryFn: () =>
      apiCall<MetricsBlocks>(() =>
        forgeAuthApi.workflows[workflow_id]!.metrics.blocks.get({ $query: toParams(query) })
      ),
    retry: false,
    refetchInterval: dashboardPollInterval,
  });

export const workflowTimeseriesQueryOptions = (workflow_id: string, query: BucketedQuery) =>
  queryOptions({
    queryKey: ['workflows', workflow_id, 'timeseries', query],
    queryFn: () =>
      apiCall<MetricsTimeseries>(() =>
        forgeAuthApi.workflows[workflow_id]!.metrics.timeseries.get({ $query: toParams(query) })
      ),
    retry: false,
    refetchInterval: dashboardPollInterval,
  });

export const workflowAgentQueryOptions = (
  workflow_id: string,
  agent_id: string,
  query: BucketedQuery
) =>
  queryOptions({
    queryKey: ['workflows', workflow_id, 'agents', agent_id, query],
    queryFn: () =>
      apiCall<MetricsAgentDetails>(() =>
        forgeAuthApi.workflows[workflow_id]!.metrics.agents[agent_id]!.get({
          $query: toParams(query),
        })
      ),
    retry: false,
  });

export const workflowDistributionQueryOptions = (workflow_id: string, query: DistributionQuery) =>
  queryOptions({
    queryKey: ['workflows', workflow_id, 'distribution', query],
    queryFn: () =>
      apiCall<MetricsDistribution>(() =>
        forgeAuthApi.workflows[workflow_id]!.metrics.distribution.get({ $query: toParams(query) })
      ),
    retry: false,
    refetchInterval: dashboardPollInterval,
  });

export const workflowRequestsQueryOptions = (workflow_id: string, query: RequestsQuery) =>
  queryOptions({
    queryKey: ['workflows', workflow_id, 'requests', query],
    queryFn: () =>
      apiCall<RequestList>(() =>
        forgeAuthApi.workflows[workflow_id]!.requests.get({ $query: toParams(query) })
      ),
    retry: false,
    refetchInterval: dashboardPollInterval,
  });

export const workflowRequestTraceQueryOptions = (
  workflow_id: string,
  session_id: string,
  query: RangeQuery
) =>
  queryOptions({
    queryKey: ['workflows', workflow_id, 'requests', session_id, 'trace', query],
    queryFn: () =>
      apiCall<RequestTrace>(() =>
        forgeAuthApi.workflows[workflow_id]!.requests[session_id]!.get({ $query: toParams(query) })
      ),
    retry: false,
  });
