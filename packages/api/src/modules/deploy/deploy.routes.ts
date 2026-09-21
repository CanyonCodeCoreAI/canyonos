import { Elysia, sse } from 'elysia';
import { z } from 'zod';

import { notFound } from '@core/errors';

import { resolveAuth as resolve_auth } from '../auth/auth.middleware';
import { resolveProjectAccess } from '../auth/project-access';
import { get_deploy_preview } from './deploy.preview.service';
import { deployments_repo } from './deploy.repo';
import {
  get_deploy_config,
  get_deployment_info,
  get_project_deploy_summary,
  stop_deployment,
  test_deployment,
  trigger_deploy,
} from './deploy.service';
import { stream_deployment_events } from './deploy.stream';
import {
  DeployConfigSchema,
  DeploymentInfoSchema,
  DeployPreviewSchema,
  DeployStopAcceptedSchema,
  DeployTestBodySchema,
  DeployTestResultSchema,
  ProjectDeployAcceptedSchema,
  ProjectDeploySummarySchema,
  TriggerDeployBodySchema,
} from './deploy.types';

const doc = { tags: ['Deploy'], security: [{ bearerAuth: [] }] };
const ProjectParams = z.object({ project_id: z.string().uuid() });
const ProjectDeploymentParams = ProjectParams.extend({ deploy_id: z.string().uuid() });

export const deployRoutes = new Elysia({ name: 'deploy.routes' })
  .resolve(async ({ request }) => ({ auth: await resolve_auth(request) }))
  .resolve(resolveProjectAccess)
  .get(
    '/:project_id/deploy/config',
    ({ params, company_id }) => get_deploy_config(company_id, params.project_id),
    {
      params: ProjectParams,
      response: { 200: DeployConfigSchema },
      detail: { ...doc, summary: 'Get project deploy configuration' },
    }
  )
  .get(
    '/:project_id/deploy/summary',
    ({ params }) => get_project_deploy_summary(params.project_id),
    {
      params: ProjectParams,
      response: { 200: ProjectDeploySummarySchema },
      detail: { ...doc, summary: "Get a project's deploy summary" },
    }
  )
  .get('/:project_id/deploy/preview', ({ params }) => get_deploy_preview(params.project_id), {
    params: ProjectParams,
    response: { 200: DeployPreviewSchema },
    detail: { ...doc, summary: 'Preview file changes before deploy' },
  })
  .post(
    '/:project_id/deploy',
    async ({ params, auth, company_id, set }) => {
      const result = await trigger_deploy(company_id, auth.sub, params.project_id);
      set.status = 202;
      return result;
    },
    {
      params: ProjectParams,
      body: TriggerDeployBodySchema,
      response: { 202: ProjectDeployAcceptedSchema },
      detail: { ...doc, summary: 'Submit a project deployment' },
    }
  )

  .get(
    '/:project_id/deploy/:deploy_id',
    ({ params }) => get_deployment_info(params.project_id, params.deploy_id),
    {
      params: ProjectDeploymentParams,
      response: { 200: DeploymentInfoSchema },
      detail: { ...doc, summary: 'Get a deployment' },
    }
  )
  .post(
    '/:project_id/deploy/:deploy_id/test',
    ({ params, body }) => test_deployment(params.project_id, params.deploy_id, body),
    {
      params: ProjectDeploymentParams,
      body: DeployTestBodySchema,
      response: { 200: DeployTestResultSchema },
      detail: { ...doc, summary: 'Send a test request to a deployment endpoint' },
    }
  )
  .post(
    '/:project_id/deploy/:deploy_id/stop',
    async ({ params, set }) => {
      const result = await stop_deployment(params.project_id, params.deploy_id);
      set.status = 202;
      return result;
    },
    {
      params: ProjectDeploymentParams,
      response: { 202: DeployStopAcceptedSchema },
      detail: { ...doc, summary: "Tear down a deployment's instances" },
    }
  )
  .get(
    '/:project_id/deploy/:deploy_id/stream',
    async ({ params, headers }) => {
      const deployment = await deployments_repo.find_by_project(
        params.deploy_id,
        params.project_id
      );
      if (!deployment) {
        throw notFound('deploy.not_found', 'Deployment not found');
      }
      return sse(stream_deployment_events(deployment.id, headers['last-event-id']));
    },
    {
      params: ProjectDeploymentParams,
      detail: { ...doc, summary: 'Stream deployment progress (SSE)' },
    }
  );
