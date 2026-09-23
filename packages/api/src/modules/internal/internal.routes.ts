import { Elysia } from 'elysia';
import { z } from 'zod';

import { notFound } from '@core/errors';

import {
  get_blob,
  list_deployment_manifest_files,
  list_project_runtime_files,
} from './internal.service';
import { DeploymentManifestSchema, RuntimeFilesSchema } from './internal.types';

// Runtime-facing routes that serve file bytes from the store.
// TODO: unauthenticated for now — guard with a service-token resolver before public exposure.
const doc = { tags: ['Internal'] };
const HASH = z.string().regex(/^[a-f0-9]{64}$/);

export const internalRoutes = new Elysia({ prefix: '/internal', name: 'internal.routes' })
  .get(
    '/projects/:project_id/files',
    ({ params }) => list_project_runtime_files(params.project_id),
    {
      params: z.object({ project_id: z.string().uuid() }),
      response: { 200: RuntimeFilesSchema },
      detail: { ...doc, summary: 'Current project files with bytes (runtime source)' },
    }
  )
  .get(
    '/deployments/:deploy_id/files',
    ({ params }) => list_deployment_manifest_files(params.deploy_id),
    {
      params: z.object({ deploy_id: z.string().uuid() }),
      response: { 200: DeploymentManifestSchema },
      detail: { ...doc, summary: "A deployment's exact shipped file set from its manifest" },
    }
  )
  .get(
    '/blobs/:content_hash',
    async ({ params, set }) => {
      const content = await get_blob(params.content_hash);
      if (content === null) {
        throw notFound('internal.blob_not_found', `No blob for ${params.content_hash}`);
      }
      set.headers['content-type'] = 'text/plain; charset=utf-8';
      return content;
    },
    {
      params: z.object({ content_hash: HASH }),
      detail: { ...doc, summary: 'Raw bytes for a content hash' },
    }
  );
