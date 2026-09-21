import { badRequest, conflict, internalError, notFound } from '@core/errors';
import { LOG_DOMAINS, logger } from '@core/logger';

import { blob_store } from '../storage/file-storage';
import { workflows_queue } from '../workflows/workflows.queue';
import { workflows_repo } from '../workflows/workflows.repo';
import { admitFiles } from './projects.admit';
import { containsNullChar, MAX_FILE_BYTES } from './projects.files';
import { projects_repo } from './projects.repo';
import type { FileRecord } from './projects.repo';
import type {
  CreateProjectInput,
  CreateProjectResult,
  FileContent,
  FileMeta,
  ProjectStats,
  ProjectStatus,
  ProjectSummary,
} from './projects.types';

const projects_logger = logger.child({ domain: LOG_DOMAINS.HTTP });
function project_not_found(project_id: string) {
  return notFound('projects.not_found', `Project "${project_id}" was not found`);
}

function file_not_found(file_id: string) {
  return notFound('projects.file_not_found', `File "${file_id}" was not found`);
}

// A referenced blob that the provider cannot return is data corruption, not a client error: the row
// points at a content hash whose bytes are gone. Surface it as a 500 rather than a silent empty file.
async function read_blob(content_hash: string): Promise<string> {
  const content = await blob_store.get(content_hash);
  if (content === null) {
    throw internalError('projects.blob_missing', `Missing stored content for ${content_hash}`);
  }
  return content;
}

async function to_file_content(file: FileRecord): Promise<FileContent> {
  const { content_hash, ...meta } = file;
  return { ...meta, content: await read_blob(content_hash) };
}

// Workflow regeneration is best-effort: a queue failure must not fail the write the user just made.
function enqueue_regeneration(project_id: string, workflow_ids: readonly string[]): void {
  try {
    workflows_queue.enqueue_all(project_id, workflow_ids);
  } catch (error) {
    projects_logger.error('failed to enqueue workflow regeneration', { project_id, error });
  }
}

export async function create_project(
  user_id: string,
  input: CreateProjectInput
): Promise<CreateProjectResult> {
  const file_rows = admitFiles(input.files);
  const company_id = await projects_repo.find_company_for_user(user_id);
  if (!company_id) {
    throw conflict('projects.no_company', 'Complete onboarding before creating a project');
  }

  const persist_files = await Promise.all(
    file_rows.map(async ({ content, ...meta }) => ({
      ...meta,
      content_hash: await blob_store.put(content),
    }))
  );

  const project_name = input.name.trim();
  let result: CreateProjectResult;
  try {
    result = await projects_repo.create_with_files(
      company_id,
      user_id,
      { name: project_name },
      persist_files
    );
  } catch (error) {
    projects_logger.error('project persistence failed', { user_id, error });
    throw internalError('projects.create_failed', 'Failed to create project', { cause: error });
  }

  projects_logger.info('project created from upload', {
    user_id,
    project_id: result.project.id,
    file_count: file_rows.length,
    workflow_count: result.workflows.length,
  });

  enqueue_regeneration(
    result.project.id,
    result.workflows.map(({ id }) => id)
  );
  return result;
}

export async function list_projects(): Promise<ProjectSummary[]> {
  return projects_repo.list_with_counts();
}

export async function get_project(project_id: string): Promise<ProjectSummary> {
  const project = await projects_repo.get_with_count(project_id);
  if (!project) throw project_not_found(project_id);
  return project;
}

export async function get_project_status(project_id: string): Promise<ProjectStatus> {
  const project = await projects_repo.get_with_count(project_id);
  if (!project) throw project_not_found(project_id);

  const workflows = await workflows_repo.list_generation_states(project_id);
  if (workflows.length === 0) {
    return {
      project_id,
      status: 'FAILED',
      error_message: 'No workflow source files were found',
      updated_at: project.updated_at,
    };
  }

  const updated_at = workflows.reduce((latest, workflow) => {
    const candidate = workflow.stale_at ?? workflow.updated_at;
    return candidate > latest ? candidate : latest;
  }, project.updated_at);

  if (
    workflows.some(
      (workflow) =>
        workflow.generation_status === 'PENDING' ||
        workflow.generation_status === 'GENERATING' ||
        workflow.stale_at !== null
    )
  ) {
    return { project_id, status: 'PENDING', error_message: null, updated_at };
  }

  // A READY workflow with no design is a failed generation that never wrote its output.
  const failed = workflows.find(
    (workflow) =>
      workflow.generation_status === 'FAILED' ||
      (workflow.generation_status === 'READY' && !workflow.has_design)
  );
  if (failed) {
    return {
      project_id,
      status: 'FAILED',
      error_message:
        failed.error_message ??
        (failed.generation_status === 'READY'
          ? 'Workflow design is missing'
          : 'Workflow generation failed'),
      updated_at,
    };
  }

  return { project_id, status: 'READY', error_message: null, updated_at };
}

export async function get_project_stats(project_id: string): Promise<ProjectStats> {
  const counts = await projects_repo.get_component_counts(project_id);
  if (!counts) throw project_not_found(project_id);

  const workflows = await workflows_repo.list_generation_states(project_id);
  return {
    project_id,
    ...counts,
    workflow_count: workflows.length,
    ready_workflow_count: workflows.filter(
      (workflow) =>
        workflow.generation_status === 'READY' && workflow.stale_at === null && workflow.has_design
    ).length,
  };
}

export async function list_project_files(project_id: string): Promise<FileMeta[]> {
  return projects_repo.list_files(project_id);
}

export async function get_project_file(project_id: string, file_id: string): Promise<FileContent> {
  const file = await projects_repo.get_file(project_id, file_id);
  if (!file) throw file_not_found(file_id);
  return to_file_content(file);
}

export async function update_project_file(
  project_id: string,
  file_id: string,
  content: string
): Promise<FileContent> {
  const byte_size = Buffer.byteLength(content, 'utf8');
  if (byte_size > MAX_FILE_BYTES) {
    throw badRequest('projects.file_too_large', 'File exceeds the size limit');
  }
  if (containsNullChar(content)) {
    throw badRequest('projects.invalid_content', 'File content contains a NUL byte');
  }

  const content_hash = await blob_store.put(content);
  const updated = await projects_repo.update_file_content(
    project_id,
    file_id,
    content_hash,
    byte_size
  );
  if (!updated) throw file_not_found(file_id);

  enqueue_regeneration(project_id, updated.workflow_ids);
  const { content_hash: _hash, ...meta } = updated.file;
  return { ...meta, content };
}

export async function delete_project_file(project_id: string, file_id: string): Promise<void> {
  const workflow_ids = await projects_repo.delete_file_and_mark_workflows_stale(
    project_id,
    file_id
  );
  if (!workflow_ids) throw file_not_found(file_id);

  enqueue_regeneration(project_id, workflow_ids);
}

export async function delete_project(project_id: string): Promise<void> {
  const deleted = await projects_repo.delete_project(project_id);
  if (!deleted) throw project_not_found(project_id);
}
