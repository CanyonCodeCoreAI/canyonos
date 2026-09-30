import { notFound } from '@core/errors';

import { projects_repo } from './projects.repo';
import type { ProjectStats, ProjectSummary } from './projects.types';

function project_not_found(project_id: string) {
  return notFound('projects.not_found', `Project "${project_id}" was not found`);
}

export async function list_projects(): Promise<ProjectSummary[]> {
  return projects_repo.list_with_counts();
}

export async function get_project(project_id: string): Promise<ProjectSummary> {
  const project = await projects_repo.get_with_count(project_id);
  if (!project) throw project_not_found(project_id);
  return project;
}

export async function get_project_stats(project_id: string): Promise<ProjectStats> {
  const counts = await projects_repo.get_component_counts(project_id);
  if (!counts) throw project_not_found(project_id);

  const workflow_counts = await projects_repo.get_workflow_counts(project_id);
  return { project_id, ...counts, ...workflow_counts };
}
