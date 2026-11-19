// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { Elysia } from 'elysia';
import { z } from 'zod';

import { databasePlugin } from '@api/db/database';

import { governanceRoutes } from '../governance/governance.routes';
import { metricsRoutes } from '../metrics/metrics.routes';
import { monitoringRoutes } from '../monitoring/monitoring.routes';
import { promptsRoutes } from '../prompts/prompts.routes';
import { requestsRoutes } from '../requests/requests.routes';
import { scalingRoutes } from '../scaling/scaling.routes';
import { add_sample_data } from './sample-data';
import { resolve_workflow_access } from './workflows.access';
import {
  delete_workflow,
  get_workflow,
  get_workflow_stats,
  list_workflows,
} from './workflows.service';
import {
  SampleDataBody,
  SampleDataSchema,
  WorkflowDeletedSchema,
  WorkflowIdParams,
  WorkflowStatsSchema,
  WorkflowSummarySchema,
} from './workflows.types';

const doc = { tags: ['Workflows'], security: [{ bearerAuth: [] }] };

export const workflowsRoutes = new Elysia({ prefix: '/workflows', name: 'workflows.routes' })
  .use(databasePlugin)
  .get('/', () => list_workflows(), {
    response: { 200: z.array(WorkflowSummarySchema) },
    detail: doc,
  })
  .resolve(resolve_workflow_access)
  .get('/:workflow_id', ({ params }) => get_workflow(params.workflow_id), {
    params: WorkflowIdParams,
    response: { 200: WorkflowSummarySchema },
    detail: doc,
  })
  .delete('/:workflow_id', ({ params }) => delete_workflow(params.workflow_id), {
    params: WorkflowIdParams,
    response: { 200: WorkflowDeletedSchema },
    detail: { ...doc, summary: 'Delete a workflow that is not running' },
  })
  .get('/:workflow_id/stats', ({ params }) => get_workflow_stats(params.workflow_id), {
    params: WorkflowIdParams,
    response: { 200: WorkflowStatsSchema },
    detail: { ...doc, summary: 'Get workflow statistics' },
  })
  .post(
    '/:workflow_id/sample-data',
    ({ params, body }) => add_sample_data(params.workflow_id, body.workflow),
    {
      params: WorkflowIdParams,
      body: SampleDataBody,
      response: { 200: SampleDataSchema },
      detail: {
        ...doc,
        summary: 'Add the recorded example run to this workflow',
        description:
          'Replays a run of the named bundled workflow that this API ships, spread across the ' +
          'week ending now, so a first run opens a dashboard with history rather than one ' +
          'request. The body names a workflow, never data: the only rows it can write are its ' +
          'own. Repeatable, and it never touches rows the workflow produced itself.',
      },
    }
  )
  .use(requestsRoutes)
  .use(metricsRoutes)
  .use(monitoringRoutes)
  .use(promptsRoutes)
  .use(scalingRoutes)
  .use(governanceRoutes);
