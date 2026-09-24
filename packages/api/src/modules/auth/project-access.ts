import { notFound } from '@core/errors';

import { projects_repo } from '../projects/projects.repo';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Shared `resolve` for every project-scoped route (projects, workflows, deploy, requests, metrics).
 * One install serves one team, so every signed-in caller reaches every project and only a project
 * that does not exist is a 404. It authenticates nothing itself, so mount it after the auth
 * resolver. It hands back the company that owns the project, which the company-scoped writes below
 * it (deploy setups, deployment rows) still need.
 */
export async function resolveProjectAccess({
  params,
}: {
  params: { project_id?: string } & Record<string, unknown>;
}): Promise<{ company_id: string }> {
  const project_id = params?.project_id;
  const company_id =
    project_id && UUID_RE.test(project_id)
      ? await projects_repo.find_project_company(project_id)
      : undefined;

  if (!company_id) {
    throw notFound('projects.not_found', `Project "${project_id}" was not found`);
  }
  return { company_id };
}
