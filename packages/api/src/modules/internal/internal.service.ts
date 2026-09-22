import { internalError } from '@core/errors';

import { deployments_repo } from '../deploy/deploy.repo';
import { projects_repo } from '../projects/projects.repo';
import { blob_store } from '../storage/file-storage';
import type { DeploymentManifestFile, RuntimeFile } from './internal.types';

// A referenced blob the provider can't return is corruption — surface it, don't emit an empty file.
async function reconstruct(content_hash: string): Promise<string> {
  const content = await blob_store.get(content_hash);
  if (content === null) {
    throw internalError('internal.blob_missing', `Missing stored content for ${content_hash}`);
  }
  return content;
}

/** The current file set of a project, bytes inlined from the store — the runtime's file source. */
export async function list_project_runtime_files(project_id: string): Promise<RuntimeFile[]> {
  const rows = await projects_repo.list_project_file_blobs(project_id);
  return Promise.all(
    rows.map(async ({ path, content_hash, component_kind }) => ({
      path,
      component_kind,
      content: await reconstruct(content_hash),
    }))
  );
}

/** The exact file set a deployment shipped, from its immutable manifest — reproducible after edits. */
export async function list_deployment_manifest_files(
  deploy_id: string
): Promise<DeploymentManifestFile[]> {
  const rows = await deployments_repo.list_manifest(deploy_id);
  return Promise.all(
    rows.map(async ({ path, content_hash, byte_size, component_kind }) => ({
      path,
      component_kind,
      byte_size,
      content: await reconstruct(content_hash),
    }))
  );
}

/** The raw bytes for a content hash, or null when the store holds no such blob. */
export function get_blob(content_hash: string): Promise<string | null> {
  return blob_store.get(content_hash);
}
