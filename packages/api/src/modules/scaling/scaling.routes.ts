import { Elysia } from 'elysia';

import { resolveAuth } from '../auth/auth.middleware';
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
  ScalingStatusSchema,
} from './scaling.types';

const doc = { tags: ['Scaling'], security: [{ bearerAuth: [] }] };

export const scalingRoutes = new Elysia({ name: 'scaling.routes' })
  .resolve(async ({ request }) => ({ auth: await resolveAuth(request) }))
  .resolve(resolveProjectAccess)
  .get('/:project_id/scaling', ({ params }) => get_scaling(params.project_id), {
    params: ProjectIdParams,
    response: { 200: ScalingStatusSchema },
    detail: { ...doc, summary: 'Get the autoscaling policy of the running project' },
  })
  .put('/:project_id/scaling', ({ params, body }) => save_scaling_policy(params.project_id, body), {
    params: ProjectIdParams,
    body: ScalingPolicySchema,
    response: { 200: ScalingPolicySchema },
    detail: { ...doc, summary: 'Create or replace the autoscaling policy applied to every agent' },
  })
  .delete('/:project_id/scaling', ({ params }) => delete_scaling_policy(params.project_id), {
    params: ProjectIdParams,
    response: { 200: ScalingDeleteResponseSchema },
    detail: { ...doc, summary: 'Delete the autoscaling policy' },
  })
  .get('/:project_id/scaling/agents', ({ params }) => list_scaling_agents(params.project_id), {
    params: ProjectIdParams,
    response: { 200: ScalingAgentsResponseSchema },
    detail: { ...doc, summary: 'List the agents the policy applies to and their current replicas' },
  });
