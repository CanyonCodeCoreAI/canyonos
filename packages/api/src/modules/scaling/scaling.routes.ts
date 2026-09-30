import { Elysia } from 'elysia';
import { z } from 'zod';

import { resolveAuth } from '../auth/auth.middleware';
import { resolveProjectAccess } from '../auth/project-access';
import { ProjectIdParams } from '../projects/projects.types';
import { delete_scaling_policy, get_scaling, save_scaling_policy } from './scaling.service';
import {
  ScalingDeleteResponseSchema,
  ScalingPolicySchema,
  ScalingResponseSchema,
} from './scaling.types';

const doc = { tags: ['Scaling'], security: [{ bearerAuth: [] }] };
const ProjectAgentParams = ProjectIdParams.extend({ agent_name: z.string().min(1) });

export const scalingRoutes = new Elysia({ name: 'scaling.routes' })
  .resolve(async ({ request }) => ({ auth: await resolveAuth(request) }))
  .resolve(resolveProjectAccess)
  .get('/:project_id/scaling', ({ params }) => get_scaling(params.project_id), {
    params: ProjectIdParams,
    response: { 200: ScalingResponseSchema },
    detail: { ...doc, summary: 'Get autoscaling policies for the running project' },
  })
  .put(
    '/:project_id/scaling/:agent_name',
    ({ params, body }) => save_scaling_policy(params.project_id, params.agent_name, body),
    {
      params: ProjectAgentParams,
      body: ScalingPolicySchema,
      response: { 200: ScalingPolicySchema },
      detail: { ...doc, summary: 'Save one agent autoscaling policy' },
    }
  )
  .delete(
    '/:project_id/scaling/:agent_name',
    ({ params }) => delete_scaling_policy(params.project_id, params.agent_name),
    {
      params: ProjectAgentParams,
      response: { 200: ScalingDeleteResponseSchema },
      detail: { ...doc, summary: 'Delete one agent autoscaling policy' },
    }
  );
