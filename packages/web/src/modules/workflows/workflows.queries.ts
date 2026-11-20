// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';

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

import { apiCall, canyonosAuthApi } from '@/api';
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
    queryFn: () => apiCall<WorkflowSummary>(() => canyonosAuthApi.v1.workflows[workflow_id]!.get()),
    retry: false,
  });
}

/** The workflow's API routes under its workflow group, read from the workflow's cached summary. */
export async function groupWorkflowApi(client: QueryClient, workflow_id: string) {
  const { workflow_group_id } = await client.ensureQueryData(
    workflowDetailQueryOptions(workflow_id)
  );
  // A workflow in no group has none: the API refuses the `null` it is sent.
  const api = canyonosAuthApi.v1['workflow-groups'][workflow_group_id!]!.workflows[workflow_id]!;
  // Wrapped, since awaiting an Eden client calls its `then` as an HTTP method.
  return { api };
}

export function useDeleteWorkflow(workflow_id: string) {
  const query_client = useQueryClient();

  return useMutation({
    mutationFn: () =>
      apiCall<WorkflowDeleted>(async () =>
        (await groupWorkflowApi(query_client, workflow_id)).api.history.delete()
      ),
    onSuccess: () =>
      query_client.invalidateQueries({ queryKey: workflowQueryKeys.all, exact: true }),
  });
}

export const workflowsQueryOptions = () =>
  queryOptions({
    queryKey: workflowQueryKeys.all,
    queryFn: () => apiCall<WorkflowSummary[]>(() => canyonosAuthApi.v1.workflows.get()),
    retry: false,
  });

export const fleetOverviewQueryOptions = (query: RangeQuery) =>
  queryOptions({
    queryKey: ['resources', 'overview', query],
    queryFn: () =>
      apiCall<FleetOverview>(() =>
        canyonosAuthApi.v1.resources.overview.get({ $query: toParams(query) })
      ),
    retry: false,
  });

export const workflowKpisQueryOptions = (workflow_id: string, query: RangeQuery) =>
  queryOptions({
    queryKey: ['workflows', workflow_id, 'kpis', query],
    queryFn: ({ client }) =>
      apiCall<MetricsKpis>(async () =>
        (await groupWorkflowApi(client, workflow_id)).api.metrics.kpis.get({
          $query: toParams(query),
        })
      ),
    retry: false,
    refetchInterval: dashboardPollInterval,
  });

export const workflowBlocksQueryOptions = (workflow_id: string, query: RangeQuery) =>
  queryOptions({
    queryKey: ['workflows', workflow_id, 'blocks', query],
    queryFn: ({ client }) =>
      apiCall<MetricsBlocks>(async () =>
        (await groupWorkflowApi(client, workflow_id)).api.metrics.blocks.get({
          $query: toParams(query),
        })
      ),
    retry: false,
    refetchInterval: dashboardPollInterval,
  });

export const workflowTimeseriesQueryOptions = (workflow_id: string, query: BucketedQuery) =>
  queryOptions({
    queryKey: ['workflows', workflow_id, 'timeseries', query],
    queryFn: ({ client }) =>
      apiCall<MetricsTimeseries>(async () =>
        (await groupWorkflowApi(client, workflow_id)).api.metrics.timeseries.get({
          $query: toParams(query),
        })
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
    queryFn: ({ client }) =>
      apiCall<MetricsAgentDetails>(async () =>
        (await groupWorkflowApi(client, workflow_id)).api.metrics.agents[agent_id]!.get({
          $query: toParams(query),
        })
      ),
    retry: false,
  });

export const workflowDistributionQueryOptions = (workflow_id: string, query: DistributionQuery) =>
  queryOptions({
    queryKey: ['workflows', workflow_id, 'distribution', query],
    queryFn: ({ client }) =>
      apiCall<MetricsDistribution>(async () =>
        (await groupWorkflowApi(client, workflow_id)).api.metrics.distribution.get({
          $query: toParams(query),
        })
      ),
    retry: false,
    refetchInterval: dashboardPollInterval,
  });

export const workflowRequestsQueryOptions = (workflow_id: string, query: RequestsQuery) =>
  queryOptions({
    queryKey: ['workflows', workflow_id, 'requests', query],
    queryFn: ({ client }) =>
      apiCall<RequestList>(async () =>
        (await groupWorkflowApi(client, workflow_id)).api.requests.get({ $query: toParams(query) })
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
    queryFn: ({ client }) =>
      apiCall<RequestTrace>(async () =>
        (await groupWorkflowApi(client, workflow_id)).api.requests[session_id]!.get({
          $query: toParams(query),
        })
      ),
    retry: false,
  });
