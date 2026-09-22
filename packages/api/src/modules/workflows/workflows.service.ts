import { notFound } from '@core/errors';
import { LOG_DOMAINS, logger } from '@core/logger';
import { record } from '@core/telemetry';

import { projects_repo } from '../projects/projects.repo';
import { blob_store } from '../storage/file-storage';
import { generate_workflow_from_files, GENERATION_ENGINE } from './workflows.graph';
import { workflows_repo } from './workflows.repo';
import { derive_workflow_status } from './workflows.status';
import type { ProjectWorkflowClaim } from './workflows.repo';
import type {
  ProjectWorkflowDesign,
  ProjectWorkflowDetail,
  ProjectWorkflowSummary,
} from './workflows.types';

const workflows_logger = logger.child({ domain: LOG_DOMAINS.HTTP });
const unexpected_generation_error = 'Unexpected workflow generation failure';

function workflow_not_found(project_id: string, workflow_id: string) {
  return notFound(
    'workflow.not_found',
    `Workflow "${workflow_id}" was not found in project "${project_id}"`
  );
}

export const workflows_service = {
  async list(project_id: string): Promise<ProjectWorkflowSummary[]> {
    const rows = await workflows_repo.list_for_project(project_id);
    return rows.map((row) => ({
      id: row.id,
      project_id: row.project_id,
      source_file_id: row.source_file_id,
      source_path: row.source_path,
      updated_at: row.updated_at,
      status: derive_workflow_status(row),
    }));
  },

  async get_detail(project_id: string, workflow_id: string): Promise<ProjectWorkflowDetail> {
    const row = await workflows_repo.find_in_project(project_id, workflow_id);
    if (!row) throw workflow_not_found(project_id, workflow_id);
    return {
      id: row.id,
      project_id: row.project_id,
      source_file_id: row.source_file_id,
      source_path: row.source_path,
      updated_at: row.updated_at,
      status: derive_workflow_status({
        generation_status: row.generation_status,
        stale_at: row.stale_at,
        has_design: row.design !== null,
      }),
    };
  },

  async get_design(project_id: string, workflow_id: string): Promise<ProjectWorkflowDesign> {
    const row = await workflows_repo.find_in_project(project_id, workflow_id);
    if (!row || row.generation_status !== 'READY' || !row.design) {
      throw workflow_not_found(project_id, workflow_id);
    }
    return {
      id: row.id,
      project_id: row.project_id,
      source_file_id: row.source_file_id,
      source_path: row.source_path,
      nodes: [...row.design.nodes],
      edges: [...row.design.edges],
      name: row.design.name ?? row.project_name,
      summary: row.design.summary ?? '',
      stats: [...(row.design.stats ?? [])],
      updated_at: row.updated_at,
    };
  },

  async regenerate(project_id: string, workflow_id: string): Promise<void> {
    let claim: ProjectWorkflowClaim | undefined;
    try {
      await record(
        'workflows.regenerate',
        async () => {
          claim = await workflows_repo.claim_generation(project_id, workflow_id);
          if (!claim) return;
          const input = await projects_repo.get_generation_input(
            project_id,
            workflow_id,
            claim.source_file_id
          );
          if (!input) {
            await workflows_repo.complete_failed(
              project_id,
              workflow_id,
              claim.generation_revision,
              GENERATION_ENGINE,
              'Workflow source is unavailable'
            );
            return;
          }

          const files = await Promise.all(
            input.files.map(async ({ path, content_hash }) => {
              const content = await blob_store.get(content_hash);
              if (content === null) {
                throw new Error(`Missing stored content for ${path} (${content_hash})`);
              }
              return { path, content };
            })
          );

          const result = await generate_workflow_from_files({
            project_name: input.name,
            source_path: input.source_path,
            files,
          });

          if (result.status === 'ready') {
            const completed = await workflows_repo.complete_ready(
              project_id,
              workflow_id,
              claim.generation_revision,
              GENERATION_ENGINE,
              {
                ...result.design,
                name: result.stats.name,
                summary: result.stats.summary,
                stats: result.stats.stats,
              }
            );
            if (!completed) {
              workflows_logger.info('ignored superseded workflow generation', {
                project_id,
                workflow_id,
                generation_revision: claim.generation_revision,
              });
            }
            return;
          }

          const completed = await workflows_repo.complete_failed(
            project_id,
            workflow_id,
            claim.generation_revision,
            GENERATION_ENGINE,
            result.error_message
          );
          if (!completed) {
            workflows_logger.info('ignored superseded workflow generation failure', {
              project_id,
              workflow_id,
              generation_revision: claim.generation_revision,
            });
          } else {
            workflows_logger.warn('workflow generation failed', {
              project_id,
              workflow_id,
              reason: result.error_message,
            });
          }
        },
        { project_id, workflow_id }
      );
    } catch (error) {
      if (claim) {
        try {
          const completed = await workflows_repo.complete_failed(
            project_id,
            workflow_id,
            claim.generation_revision,
            GENERATION_ENGINE,
            unexpected_generation_error
          );
          if (!completed) {
            workflows_logger.info('ignored superseded workflow generation crash', {
              project_id,
              workflow_id,
              generation_revision: claim.generation_revision,
            });
          }
        } catch (finalization_error) {
          workflows_logger.error('failed to finalize crashed workflow generation', {
            project_id,
            workflow_id,
            generation_revision: claim.generation_revision,
            error: finalization_error,
          });
        }
      }
      workflows_logger.error('workflow regenerate crashed', { project_id, workflow_id, error });
    }
  },
};
