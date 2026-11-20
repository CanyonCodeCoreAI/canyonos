// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { Elysia } from 'elysia';

import { databasePlugin } from '@api/db/database';

import { resolve_group_workflow_access } from '../workflows/workflows.access';
import { GroupWorkflowParams } from '../workflows/workflows.types';
import {
  delete_scaling_policy,
  get_scaling,
  list_scaling_agents,
  save_scaling_policy,
} from './scaling.service';
import {
  ScalingAgentsResponseSchema,
  ScalingDeleteResponseSchema,
  ScalingPolicySchema,
  ScalingResponseSchema,
} from './scaling.types';

const doc = { tags: ['Scaling'], security: [{ bearerAuth: [] }] };

export const scalingRoutes = new Elysia({ name: 'scaling.routes' })
  .use(databasePlugin)
  .resolve(resolve_group_workflow_access)
  .get(
    '/:workflow_group_id/workflows/:workflow_id/scaling',
    ({ params }) => get_scaling(params.workflow_id),
    {
      params: GroupWorkflowParams,
      response: { 200: ScalingResponseSchema },
      detail: { ...doc, summary: "Get the workflow's autoscaling policy" },
    }
  )
  .put(
    '/:workflow_group_id/workflows/:workflow_id/scaling',
    ({ params, body }) => save_scaling_policy(params.workflow_id, body),
    {
      params: GroupWorkflowParams,
      body: ScalingPolicySchema,
      response: { 200: ScalingPolicySchema },
      detail: {
        ...doc,
        summary: "Create or replace a workflow's autoscaling policy, applied to each of its agents",
      },
    }
  )
  .delete(
    '/:workflow_group_id/workflows/:workflow_id/scaling',
    ({ params }) => delete_scaling_policy(params.workflow_id),
    {
      params: GroupWorkflowParams,
      response: { 200: ScalingDeleteResponseSchema },
      detail: { ...doc, summary: "Delete a workflow's autoscaling policy" },
    }
  )
  .get(
    '/:workflow_group_id/workflows/:workflow_id/scaling/agents',
    ({ params }) => list_scaling_agents(params.workflow_id),
    {
      params: GroupWorkflowParams,
      response: { 200: ScalingAgentsResponseSchema },
      detail: {
        ...doc,
        summary: 'List the agents the policy applies to and their current replicas',
      },
    }
  );
