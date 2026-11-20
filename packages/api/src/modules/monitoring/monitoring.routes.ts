// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { Elysia } from 'elysia';

import { databasePlugin } from '@api/db/database';
import { GridQuerySchema, TimeRangeQuerySchema } from '@core/time-range';

import { resolve_group_workflow_access } from '../workflows/workflows.access';
import { GroupWorkflowParams } from '../workflows/workflows.types';
import {
  get_endpoint,
  get_error_summary,
  get_llm_calls,
  get_log_sources,
  get_logs,
  get_replicas,
  get_resource_utilization,
  get_series,
  get_traces,
} from './monitoring.service';
import {
  MonitoringEndpointResponseSchema,
  MonitoringErrorSummaryResponseSchema,
  MonitoringListQuerySchema,
  MonitoringLlmCallsResponseSchema,
  MonitoringLogSourcesResponseSchema,
  MonitoringLogsQuerySchema,
  MonitoringLogsResponseSchema,
  MonitoringReplicasResponseSchema,
  MonitoringResourceUtilizationResponseSchema,
  MonitoringSeriesResponseSchema,
  MonitoringTracesResponseSchema,
} from './monitoring.types';

const doc = { tags: ['Monitoring'], security: [{ bearerAuth: [] }] };

export const monitoringRoutes = new Elysia({ name: 'monitoring.routes' })
  .use(databasePlugin)
  .resolve(resolve_group_workflow_access)
  .get(
    '/:workflow_group_id/workflows/:workflow_id/monitoring/series',
    ({ params, query }) => get_series(params.workflow_id, query),
    {
      params: GroupWorkflowParams,
      query: GridQuerySchema,
      response: { 200: MonitoringSeriesResponseSchema },
      detail: {
        ...doc,
        summary: 'Golden-signal series on one shared time grid',
        description:
          'Traffic, errors and latency count each request whole in the bucket it started in; saturation samples sit at their own time.',
      },
    }
  )
  .get(
    '/:workflow_group_id/workflows/:workflow_id/monitoring/logs',
    ({ params, query }) => get_logs(params.workflow_id, query),
    {
      params: GroupWorkflowParams,
      query: MonitoringLogsQuerySchema,
      response: { 200: MonitoringLogsResponseSchema },
      detail: {
        ...doc,
        summary: 'Recent log records for the workflow, newest first',
        description: 'Each log record is in the range by its own timestamp.',
      },
    }
  )
  .get(
    '/:workflow_group_id/workflows/:workflow_id/monitoring/logs/sources',
    ({ params, query }) => get_log_sources(params.workflow_id, query),
    {
      params: GroupWorkflowParams,
      query: TimeRangeQuerySchema,
      response: { 200: MonitoringLogSourcesResponseSchema },
      detail: {
        ...doc,
        summary: 'Agents and replicas that wrote logs in the range',
        description: 'Each log record is in the range by its own timestamp.',
      },
    }
  )
  .get(
    '/:workflow_group_id/workflows/:workflow_id/monitoring/llm',
    ({ params, query }) => get_llm_calls(params.workflow_id, query),
    {
      params: GroupWorkflowParams,
      query: MonitoringListQuerySchema,
      response: { 200: MonitoringLlmCallsResponseSchema },
      detail: {
        ...doc,
        summary: 'Spans carrying a model call, newest first',
        description: 'The model calls of the requests that started in the range, each whole.',
      },
    }
  )
  .get(
    '/:workflow_group_id/workflows/:workflow_id/monitoring/traces',
    ({ params, query }) => get_traces(params.workflow_id, query),
    {
      params: GroupWorkflowParams,
      query: MonitoringListQuerySchema,
      response: { 200: MonitoringTracesResponseSchema },
      detail: {
        ...doc,
        summary: 'Recent traces with their spans, newest first',
        description: 'The requests that started in the range, each whole.',
      },
    }
  )
  .get(
    '/:workflow_group_id/workflows/:workflow_id/monitoring/errors/summary',
    ({ params, query }) => get_error_summary(params.workflow_id, query),
    {
      params: GroupWorkflowParams,
      query: TimeRangeQuerySchema,
      response: { 200: MonitoringErrorSummaryResponseSchema },
      detail: {
        ...doc,
        summary: 'Error counts grouped by exception type and by agent',
        description: 'Counts error log records, each in the range by its own timestamp.',
      },
    }
  )
  .get(
    '/:workflow_group_id/workflows/:workflow_id/monitoring/resources',
    ({ params, query }) => get_resource_utilization(params.workflow_id, query),
    {
      params: GroupWorkflowParams,
      query: GridQuerySchema,
      response: { 200: MonitoringResourceUtilizationResponseSchema },
      detail: {
        ...doc,
        summary: 'Resource utilization per machine and per agent',
        description:
          'Machine samples sit at their own time; agent CPU comes from the requests that started in the range, in the bucket each started in.',
      },
    }
  )
  .get(
    '/:workflow_group_id/workflows/:workflow_id/monitoring/replicas',
    ({ params }) => get_replicas(params.workflow_id),
    {
      params: GroupWorkflowParams,
      response: { 200: MonitoringReplicasResponseSchema },
      detail: { ...doc, summary: 'Replicas reporting up, with their queue lengths' },
    }
  )
  .get(
    '/:workflow_group_id/workflows/:workflow_id/monitoring/endpoint',
    ({ params }) => get_endpoint(params.workflow_id),
    {
      params: GroupWorkflowParams,
      response: { 200: MonitoringEndpointResponseSchema },
      detail: { ...doc, summary: 'Where the running endpoint answers' },
    }
  );
