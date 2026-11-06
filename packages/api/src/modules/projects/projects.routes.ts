// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { Elysia } from 'elysia';
import { z } from 'zod';

import { resolveAuth as resolve_auth } from '../auth/auth.middleware';
import { resolveProjectAccess } from '../auth/project-access';
import { governanceRoutes } from '../governance/governance.routes';
import { metricsRoutes } from '../metrics/metrics.routes';
import { monitoringRoutes } from '../monitoring/monitoring.routes';
import { promptsRoutes } from '../prompts/prompts.routes';
import { requestsRoutes } from '../requests/requests.routes';
import { scalingRoutes } from '../scaling/scaling.routes';
import { delete_project, get_project, get_project_stats, list_projects } from './projects.service';
import {
  ProjectDeletedSchema,
  ProjectIdParams,
  ProjectStatsSchema,
  ProjectSummarySchema,
  SampleDataBody,
  SampleDataSchema,
} from './projects.types';
import { add_sample_data } from './sample-data';

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
  .delete('/:project_id', ({ params }) => delete_project(params.project_id), {
    params: ProjectIdParams,
    response: { 200: ProjectDeletedSchema },
    detail: { ...doc, summary: 'Delete a project that is not running' },
  })
  .get('/:project_id/stats', ({ params }) => get_project_stats(params.project_id), {
    params: ProjectIdParams,
    response: { 200: ProjectStatsSchema },
    detail: { ...doc, summary: 'Get project statistics' },
  })
  .post(
    '/:project_id/sample-data',
    ({ params, body }) => add_sample_data(params.project_id, body.workflow),
    {
      params: ProjectIdParams,
      body: SampleDataBody,
      response: { 200: SampleDataSchema },
      detail: {
        ...doc,
        summary: 'Add the recorded example run to this project',
        description:
          'Replays a run of the named bundled workflow that this API ships, spread across the ' +
          'week ending now, so a first run opens a dashboard with history rather than one ' +
          'request. The body names a workflow, never data: the only rows it can write are its ' +
          'own. Repeatable, and it never touches rows the project produced itself.',
      },
    }
  )
  .use(requestsRoutes)
  .use(metricsRoutes)
  .use(monitoringRoutes)
  .use(promptsRoutes)
  .use(scalingRoutes)
  .use(governanceRoutes);
