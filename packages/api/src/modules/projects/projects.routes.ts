import { Elysia } from 'elysia';
import { z } from 'zod';

import { resolveAuth as resolve_auth } from '../auth/auth.middleware';
import { resolveProjectAccess } from '../auth/project-access';
import { metricsRoutes } from '../metrics/metrics.routes';
import { promptsRoutes } from '../prompts/prompts.routes';
import { requestsRoutes } from '../requests/requests.routes';
import { get_project, get_project_stats, list_projects } from './projects.service';
import { ProjectIdParams, ProjectStatsSchema, ProjectSummarySchema } from './projects.types';

const doc = { tags: ['Projects'], security: [{ bearerAuth: [] }] };

export const projectsRoutes = new Elysia({ prefix: '/projects', name: 'projects.routes' })
  .resolve(async ({ request }) => ({ auth: await resolve_auth(request) }))
  .get('/', () => list_projects(), {
    response: { 200: z.array(ProjectSummarySchema) },
    detail: doc,
  })
  .resolve(resolveProjectAccess)
  .get('/:project_id', ({ params }) => get_project(params.project_id), {
    params: ProjectIdParams,
    response: { 200: ProjectSummarySchema },
    detail: doc,
  })
  .get('/:project_id/stats', ({ params }) => get_project_stats(params.project_id), {
    params: ProjectIdParams,
    response: { 200: ProjectStatsSchema },
    detail: { ...doc, summary: 'Get project statistics' },
  })
  .use(requestsRoutes)
  .use(metricsRoutes)
  .use(promptsRoutes);
