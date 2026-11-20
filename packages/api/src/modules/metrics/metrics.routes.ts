// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { Elysia } from 'elysia';
import { z } from 'zod';

import { databasePlugin } from '@api/db/database';
import { GridQuerySchema, TimeRangeQuerySchema } from '@core/time-range';

import { resolve_group_workflow_access } from '../workflows/workflows.access';
import { GroupWorkflowParams } from '../workflows/workflows.types';
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

const WorkflowAgentParams = GroupWorkflowParams.extend({
  agent_id: z.string().min(1).max(255),
});

// Prefix-less: composed into workflow-groups.routes so its whole tree stays one Eden type.
export const metricsRoutes = new Elysia({ name: 'metrics.routes' })
  .use(databasePlugin)
  .resolve(resolve_group_workflow_access)
  .get(
    '/:workflow_group_id/workflows/:workflow_id/metrics/kpis',
    ({ params, query }) => get_kpis(params.workflow_id, query),
    {
      params: GroupWorkflowParams,
      query: TimeRangeQuerySchema,
      response: { 200: MetricsKpisSchema },
      detail: { ...doc, summary: 'Range-scoped KPI aggregates (tokens, costs, per-block latency)' },
    }
  )
  .get(
    '/:workflow_group_id/workflows/:workflow_id/metrics/distribution',
    ({ params, query }) => get_distribution(params.workflow_id, query),
    {
      params: GroupWorkflowParams,
      query: DistributionQuerySchema,
      response: { 200: MetricsDistributionSchema },
      detail: {
        ...doc,
        summary: 'Per-request distribution (histogram, mean, std, percentiles) for a KPI',
      },
    }
  )
  .get(
    '/:workflow_group_id/workflows/:workflow_id/metrics/timeseries',
    ({ params, query }) => get_timeseries(params.workflow_id, query),
    {
      params: GroupWorkflowParams,
      query: GridQuerySchema,
      response: { 200: MetricsTimeseriesSchema },
      detail: {
        ...doc,
        summary: 'Cost and volume per time bucket, each request in the bucket it started in',
      },
    }
  )
  .get(
    '/:workflow_group_id/workflows/:workflow_id/metrics/blocks',
    ({ params, query }) => get_blocks(params.workflow_id, query),
    {
      params: GroupWorkflowParams,
      query: TimeRangeQuerySchema,
      response: { 200: MetricsBlocksSchema },
      detail: {
        ...doc,
        summary: 'Per-agent, per-model cost breakdown with retry, failure, and latency rates',
      },
    }
  )
  .get(
    '/:workflow_group_id/workflows/:workflow_id/metrics/agents/:agent_id',
    ({ params, query }) => get_agent_details(params.workflow_id, params.agent_id, query),
    {
      params: WorkflowAgentParams,
      query: GridQuerySchema,
      response: { 200: MetricsAgentDetailsSchema },
      detail: {
        ...doc,
        summary: 'Selected agent metrics across its replicas, with per-request histograms',
      },
    }
  );
