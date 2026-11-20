// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { Elysia } from 'elysia';
import { z } from 'zod';

import { databasePlugin } from '@api/db/database';

import { add_sample_data } from './sample-data';
import { resolve_group_workflow_access } from './workflows.access';
import { delete_workflow, get_workflow, list_workflows } from './workflows.service';
import {
  GroupWorkflowParams,
  SampleDataBody,
  SampleDataSchema,
  WorkflowDeletedSchema,
  WorkflowIdParams,
  WorkflowSummarySchema,
} from './workflows.types';

const doc = { tags: ['Workflows'], security: [{ bearerAuth: [] }] };

// Every workflow this dashboard knows, in whatever workflow group: a workflow's id alone finds
// the group its other routes are under.
export const workflowsRoutes = new Elysia({ prefix: '/v1/workflows', name: 'workflows.routes' })
  .use(databasePlugin)
  .get('/', () => list_workflows(), {
    response: { 200: z.array(WorkflowSummarySchema) },
    detail: doc,
  })
  .get('/:workflow_id', ({ params }) => get_workflow(params.workflow_id), {
    params: WorkflowIdParams,
    response: { 200: WorkflowSummarySchema },
    detail: doc,
  });

// Prefix-less: composed into workflow-groups.routes, with a workflow's other dashboard routes.
export const workflowHistoryRoutes = new Elysia({ name: 'workflows.history.routes' })
  .use(databasePlugin)
  .resolve(resolve_group_workflow_access)
  .delete(
    '/:workflow_group_id/workflows/:workflow_id/history',
    ({ params }) => delete_workflow(params.workflow_id),
    {
      params: GroupWorkflowParams,
      response: { 200: WorkflowDeletedSchema },
      detail: {
        ...doc,
        summary: 'Delete a workflow that is not running, with its telemetry',
      },
    }
  )
  .post(
    '/:workflow_group_id/workflows/:workflow_id/sample-data',
    ({ params, body }) => add_sample_data(params.workflow_id, body.workflow),
    {
      params: GroupWorkflowParams,
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
  );
