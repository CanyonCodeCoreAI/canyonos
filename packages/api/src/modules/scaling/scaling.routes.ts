// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { Elysia } from 'elysia';
import { z } from 'zod';

import { authPlugin } from '../auth/auth.middleware';
import { resolveProjectAccess } from '../auth/project-access';
import { ProjectIdParams } from '../projects/projects.types';
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

// A project of the deployment: one of the folders it runs.
const ProjectPolicyParams = ProjectIdParams.extend({ project: z.string().min(1) });

const doc = { tags: ['Scaling'], security: [{ bearerAuth: [] }] };

export const scalingRoutes = new Elysia({ name: 'scaling.routes' })
  .use(authPlugin)
  .resolve(resolveProjectAccess)
  .get('/:project_id/scaling', ({ params }) => get_scaling(params.project_id), {
    params: ProjectIdParams,
    response: { 200: ScalingResponseSchema },
    detail: { ...doc, summary: 'Get the autoscaling policy of each project of the deployment' },
  })
  .put(
    '/:project_id/scaling/:project',
    ({ params, body }) => save_scaling_policy(params.project_id, params.project, body),
    {
      params: ProjectPolicyParams,
      body: ScalingPolicySchema,
      response: { 200: ScalingPolicySchema },
      detail: {
        ...doc,
        summary: "Create or replace a project's autoscaling policy, applied to each of its agents",
      },
    }
  )
  .delete(
    '/:project_id/scaling/:project',
    ({ params }) => delete_scaling_policy(params.project_id, params.project),
    {
      params: ProjectPolicyParams,
      response: { 200: ScalingDeleteResponseSchema },
      detail: { ...doc, summary: "Delete a project's autoscaling policy" },
    }
  )
  .get('/:project_id/scaling/agents', ({ params }) => list_scaling_agents(params.project_id), {
    params: ProjectIdParams,
    response: { 200: ScalingAgentsResponseSchema },
    detail: { ...doc, summary: 'List the agents the policy applies to and their current replicas' },
  });
