import { Elysia } from 'elysia';
import { z } from 'zod';

import { resolveAuth as resolve_auth } from '../auth/auth.middleware';
import { resolveProjectAccess } from '../auth/project-access';
import { workflows_service } from './workflows.service';
import {
  ProjectWorkflowDesignSchema,
  ProjectWorkflowDetailSchema,
  ProjectWorkflowSummarySchema,
} from './workflows.types';

const doc = { tags: ['Workflows'], security: [{ bearerAuth: [] }] };
const ProjectWorkflowParams = z.object({
  project_id: z.string().uuid(),
  workflow_id: z.string().uuid(),
});

export const workflowsRoutes = new Elysia({ name: 'workflows.routes' })
  .resolve(async ({ request }) => ({ auth: await resolve_auth(request) }))
  .resolve(resolveProjectAccess)
  .get('/:project_id/workflows', ({ params }) => workflows_service.list(params.project_id), {
    params: z.object({ project_id: z.string().uuid() }),
    response: { 200: z.array(ProjectWorkflowSummarySchema) },
    detail: { ...doc, summary: 'List project workflows' },
  })
  .get(
    '/:project_id/workflows/:workflow_id',
    ({ params }) => workflows_service.get_detail(params.project_id, params.workflow_id),
    {
      params: ProjectWorkflowParams,
      response: { 200: ProjectWorkflowDetailSchema },
      detail: { ...doc, summary: 'Get a project workflow' },
    }
  )
  .get(
    '/:project_id/workflows/:workflow_id/design',
    ({ params }) => workflows_service.get_design(params.project_id, params.workflow_id),
    {
      params: ProjectWorkflowParams,
      response: { 200: ProjectWorkflowDesignSchema },
      detail: { ...doc, summary: 'Get a project workflow design' },
    }
  );
