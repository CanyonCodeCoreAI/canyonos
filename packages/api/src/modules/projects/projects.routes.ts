import { Elysia } from 'elysia';
import { z } from 'zod';

import { resolveAuth as resolve_auth } from '../auth/auth.middleware';
import { resolveProjectAccess } from '../auth/project-access';
import { deployRoutes } from '../deploy/deploy.routes';
import { list_deployment_overview } from '../deploy/deploy.service';
import { DeploymentOverviewItemSchema, DeploymentStateFilterSchema } from '../deploy/deploy.types';
import { metricsRoutes } from '../metrics/metrics.routes';
import { requestsRoutes } from '../requests/requests.routes';
import { workflowsRoutes } from '../workflows/workflows.routes';
import {
  create_project,
  delete_project,
  delete_project_file,
  get_project,
  get_project_file,
  get_project_stats,
  get_project_status,
  list_project_files,
  list_projects,
  update_project_file,
} from './projects.service';
import {
  CreateProjectResultSchema,
  CreateProjectSchema,
  FileContentSchema,
  FileMetaSchema,
  FileParams,
  ProjectIdParams,
  ProjectStatsSchema,
  ProjectStatusSchema,
  ProjectSummarySchema,
  UpdateFileSchema,
} from './projects.types';

const doc = { tags: ['Projects'], security: [{ bearerAuth: [] }] };

export const projectsRoutes = new Elysia({ prefix: '/projects', name: 'projects.routes' })
  .resolve(async ({ request }) => ({ auth: await resolve_auth(request) }))
  .post('/', ({ auth, body }) => create_project(auth.sub, body), {
    body: CreateProjectSchema,
    response: { 200: CreateProjectResultSchema },
    detail: { ...doc, summary: 'Create a project from uploaded files' },
  })
  .get('/', () => list_projects(), {
    response: { 200: z.array(ProjectSummarySchema) },
    detail: doc,
  })
  .get('/deployments', ({ query }) => list_deployment_overview(query), {
    query: z.object({
      state: DeploymentStateFilterSchema.default('all'),
      limit: z.coerce.number().int().min(1).max(50).default(10),
    }),
    response: { 200: z.array(DeploymentOverviewItemSchema) },
    detail: {
      tags: ['Deploy'],
      security: [{ bearerAuth: [] }],
      summary: 'List deployment overview for the install',
    },
  })
  .resolve(resolveProjectAccess)
  .get('/:project_id', ({ params }) => get_project(params.project_id), {
    params: ProjectIdParams,
    response: { 200: ProjectSummarySchema },
    detail: doc,
  })
  .get('/:project_id/status', ({ params }) => get_project_status(params.project_id), {
    params: ProjectIdParams,
    response: { 200: ProjectStatusSchema },
    detail: { ...doc, summary: 'Get project processing status' },
  })
  .get('/:project_id/stats', ({ params }) => get_project_stats(params.project_id), {
    params: ProjectIdParams,
    response: { 200: ProjectStatsSchema },
    detail: { ...doc, summary: 'Get project statistics' },
  })
  .get('/:project_id/files', ({ params }) => list_project_files(params.project_id), {
    params: ProjectIdParams,
    response: { 200: z.array(FileMetaSchema) },
    detail: doc,
  })
  .get(
    '/:project_id/files/:file_id',
    ({ params }) => get_project_file(params.project_id, params.file_id),
    { params: FileParams, response: { 200: FileContentSchema }, detail: doc }
  )
  .patch(
    '/:project_id/files/:file_id',
    ({ params, body }) => update_project_file(params.project_id, params.file_id, body.content),
    {
      params: FileParams,
      body: UpdateFileSchema,
      response: { 200: FileContentSchema },
      detail: doc,
    }
  )
  .delete(
    '/:project_id/files/:file_id',
    ({ params }) => delete_project_file(params.project_id, params.file_id),
    { params: FileParams, detail: doc }
  )
  .delete('/:project_id', ({ params }) => delete_project(params.project_id), {
    params: ProjectIdParams,
    detail: { ...doc, summary: 'Delete a project' },
  })
  .use(workflowsRoutes)
  .use(deployRoutes)
  .use(requestsRoutes)
  .use(metricsRoutes);
