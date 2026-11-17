// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { Elysia } from 'elysia';
import { z } from 'zod';

import { GridQuerySchema, TimeRangeQuerySchema } from '@core/time-range';

import { authPlugin, requireScope } from '../auth/auth.middleware';
import { resolveProjectAccess } from '../auth/project-access';
import {
  get_agent_details,
  get_blocks,
  get_distribution,
  get_kpis,
  get_timeseries,
} from './metrics.service';
import {
  DistributionQuerySchema,
  MetricsAgentDetailsSchema,
  MetricsBlocksSchema,
  MetricsDistributionSchema,
  MetricsKpisSchema,
  MetricsTimeseriesSchema,
} from './metrics.types';

const doc = { tags: ['Metrics'], security: [{ bearerAuth: [] }] };

const ProjectIdParams = z.object({ project_id: z.string().uuid() });
const ProjectAgentParams = ProjectIdParams.extend({
  agent_id: z.string().min(1).max(255),
});

// Prefix-less: composed into projects.routes so the whole `/projects` tree stays one Eden type.
export const metricsRoutes = new Elysia({ name: 'metrics.routes' })
  .use(authPlugin)
  .resolve(resolveProjectAccess)
  .get('/:project_id/metrics/kpis', ({ params, query }) => get_kpis(params.project_id, query), {
    params: ProjectIdParams,
    query: TimeRangeQuerySchema,
    response: { 200: MetricsKpisSchema },
    beforeHandle: requireScope('read'),
    detail: { ...doc, summary: 'Range-scoped KPI aggregates (tokens, costs, per-block latency)' },
  })
  .get(
    '/:project_id/metrics/distribution',
    ({ params, query }) => get_distribution(params.project_id, query),
    {
      params: ProjectIdParams,
      query: DistributionQuerySchema,
      response: { 200: MetricsDistributionSchema },
      beforeHandle: requireScope('read'),
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
      query: GridQuerySchema,
      response: { 200: MetricsTimeseriesSchema },
      beforeHandle: requireScope('read'),
      detail: {
        ...doc,
        summary: 'Cost and volume per time bucket, each request in the bucket it started in',
      },
    }
  )
  .get('/:project_id/metrics/blocks', ({ params, query }) => get_blocks(params.project_id, query), {
    params: ProjectIdParams,
    query: TimeRangeQuerySchema,
    response: { 200: MetricsBlocksSchema },
    beforeHandle: requireScope('read'),
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
      query: GridQuerySchema,
      response: { 200: MetricsAgentDetailsSchema },
      beforeHandle: requireScope('read'),
      detail: {
        ...doc,
        summary: 'Selected agent metrics across its replicas, with per-request histograms',
      },
    }
  );
