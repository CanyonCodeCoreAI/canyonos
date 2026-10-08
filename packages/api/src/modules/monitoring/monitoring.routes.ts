import { Elysia } from 'elysia';

import { resolveAuth } from '../auth/auth.middleware';
import { resolveProjectAccess } from '../auth/project-access';
import { ProjectIdParams } from '../projects/projects.types';
import {
  get_endpoints,
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
  MonitoringEndpointsResponseSchema,
  MonitoringErrorSummaryResponseSchema,
  MonitoringListQuerySchema,
  MonitoringLlmCallsResponseSchema,
  MonitoringLogSourcesResponseSchema,
  MonitoringLogsQuerySchema,
  MonitoringLogsResponseSchema,
  MonitoringQuerySchema,
  MonitoringReplicasResponseSchema,
  MonitoringResourceUtilizationResponseSchema,
  MonitoringSeriesResponseSchema,
  MonitoringTracesResponseSchema,
} from './monitoring.types';

const doc = { tags: ['Monitoring'], security: [{ bearerAuth: [] }] };

export const monitoringRoutes = new Elysia({ name: 'monitoring.routes' })
  .resolve(async ({ request }) => ({ auth: await resolveAuth(request) }))
  .resolve(resolveProjectAccess)
  .get(
    '/:project_id/monitoring/series',
    ({ params, query }) => get_series(params.project_id, query),
    {
      params: ProjectIdParams,
      query: MonitoringQuerySchema,
      response: { 200: MonitoringSeriesResponseSchema },
      detail: { ...doc, summary: 'Golden-signal series on one shared time grid' },
    }
  )
  .get('/:project_id/monitoring/logs', ({ params, query }) => get_logs(params.project_id, query), {
    params: ProjectIdParams,
    query: MonitoringLogsQuerySchema,
    response: { 200: MonitoringLogsResponseSchema },
    detail: { ...doc, summary: 'Recent log records for the project, newest first' },
  })
  .get(
    '/:project_id/monitoring/logs/sources',
    ({ params, query }) => get_log_sources(params.project_id, query),
    {
      params: ProjectIdParams,
      query: MonitoringQuerySchema,
      response: { 200: MonitoringLogSourcesResponseSchema },
      detail: { ...doc, summary: 'Agents and replicas that wrote logs in the window' },
    }
  )
  .get(
    '/:project_id/monitoring/llm',
    ({ params, query }) => get_llm_calls(params.project_id, query),
    {
      params: ProjectIdParams,
      query: MonitoringListQuerySchema,
      response: { 200: MonitoringLlmCallsResponseSchema },
      detail: { ...doc, summary: 'Spans carrying a model call, newest first' },
    }
  )
  .get(
    '/:project_id/monitoring/traces',
    ({ params, query }) => get_traces(params.project_id, query),
    {
      params: ProjectIdParams,
      query: MonitoringListQuerySchema,
      response: { 200: MonitoringTracesResponseSchema },
      detail: { ...doc, summary: 'Recent traces with their spans, newest first' },
    }
  )
  .get(
    '/:project_id/monitoring/errors/summary',
    ({ params, query }) => get_error_summary(params.project_id, query),
    {
      params: ProjectIdParams,
      query: MonitoringQuerySchema,
      response: { 200: MonitoringErrorSummaryResponseSchema },
      detail: { ...doc, summary: 'Error counts grouped by exception type and by agent' },
    }
  )
  .get(
    '/:project_id/monitoring/resources',
    ({ params, query }) => get_resource_utilization(params.project_id, query),
    {
      params: ProjectIdParams,
      query: MonitoringQuerySchema,
      response: { 200: MonitoringResourceUtilizationResponseSchema },
      detail: { ...doc, summary: 'Resource utilization per machine and per agent' },
    }
  )
  .get('/:project_id/monitoring/replicas', ({ params }) => get_replicas(params.project_id), {
    params: ProjectIdParams,
    response: { 200: MonitoringReplicasResponseSchema },
    detail: { ...doc, summary: 'Replicas reporting up, with their queue lengths' },
  })
  .get('/:project_id/monitoring/endpoints', ({ params }) => get_endpoints(params.project_id), {
    params: ProjectIdParams,
    response: { 200: MonitoringEndpointsResponseSchema },
    detail: { ...doc, summary: 'Where the running workflow answers' },
  });
