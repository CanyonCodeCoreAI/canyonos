import { Elysia } from 'elysia';
import { z } from 'zod';

import { resolveAuth } from '../auth/auth.middleware';
import { resolveProjectAccess } from '../auth/project-access';
import {
  get_agent_details,
  get_blocks,
  get_distribution,
  get_flow,
  get_kpis,
  get_timeseries,
} from './metrics.service';
import {
  AgentDetailsQuerySchema,
  DistributionQuerySchema,
  MetricsAgentDetailsSchema,
  MetricsBlocksSchema,
  MetricsDistributionSchema,
  MetricsFlowSchema,
  MetricsKpisSchema,
  MetricsTimeseriesSchema,
  TimeseriesQuerySchema,
  TimeWindowQuerySchema,
} from './metrics.types';

const doc = { tags: ['Metrics'], security: [{ bearerAuth: [] }] };

const ProjectIdParams = z.object({ project_id: z.string().uuid() });
const ProjectAgentParams = ProjectIdParams.extend({
  agent_id: z.string().min(1).max(255),
});

// Prefix-less: composed into projects.routes so the whole `/projects` tree stays one Eden type.
export const metricsRoutes = new Elysia({ name: 'metrics.routes' })
  .resolve(async ({ request }) => ({ auth: await resolveAuth(request) }))
  .resolve(resolveProjectAccess)
  .get('/:project_id/metrics/kpis', ({ params }) => get_kpis(params.project_id), {
    params: ProjectIdParams,
    response: { 200: MetricsKpisSchema },
    detail: { ...doc, summary: 'Windowed KPI aggregates (tokens, costs, per-block latency)' },
  })
  .get(
    '/:project_id/metrics/distribution',
    ({ params, query }) => get_distribution(params.project_id, query),
    {
      params: ProjectIdParams,
      query: DistributionQuerySchema,
      response: { 200: MetricsDistributionSchema },
      detail: {
        ...doc,
        summary: 'Per-request distribution (histogram, mean, std, percentiles) for a KPI',
      },
    }
  )
  .get(
    '/:project_id/metrics/timeseries',
    ({ params, query }) => get_timeseries(params.project_id, query),
    {
      params: ProjectIdParams,
      query: TimeseriesQuerySchema,
      response: { 200: MetricsTimeseriesSchema },
      detail: { ...doc, summary: 'Cost and volume over equal-width time buckets in the window' },
    }
  )
  .get('/:project_id/metrics/blocks', ({ params, query }) => get_blocks(params.project_id, query), {
    params: ProjectIdParams,
    query: TimeWindowQuerySchema,
    response: { 200: MetricsBlocksSchema },
    detail: {
      ...doc,
      summary: 'Per-agent, per-model cost breakdown with retry, failure, and latency rates',
    },
  })
  .get(
    '/:project_id/metrics/agents/:agent_id',
    ({ params, query }) => get_agent_details(params.project_id, params.agent_id, query),
    {
      params: ProjectAgentParams,
      query: AgentDetailsQuerySchema,
      response: { 200: MetricsAgentDetailsSchema },
      detail: {
        ...doc,
        summary: 'Selected agent 30-day metrics across its replicas, with per-request histograms',
      },
    }
  )
  .get('/:project_id/metrics/flow', ({ params, query }) => get_flow(params.project_id, query), {
    params: ProjectIdParams,
    query: TimeWindowQuerySchema,
    response: { 200: MetricsFlowSchema },
    detail: {
      ...doc,
      summary: 'Execution tree as a cost-weighted dependency graph, one node per agent',
    },
  });
