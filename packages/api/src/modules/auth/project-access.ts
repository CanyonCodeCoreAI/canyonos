// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { notFound } from '@core/errors';

import { projects_repo } from '../projects/projects.repo';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Shared `resolve` for every project-scoped route (projects, requests, metrics).
 * An API token covers the whole install, so every verified caller reaches every project and only
 * a project that does not exist is a 404. It authenticates nothing itself, so mount it after
 * `authPlugin`.
 */
export async function resolveProjectAccess({
  params,
}: {
  params: { project_id?: string } & Record<string, unknown>;
}): Promise<{ project_id: string }> {
  const project_id = params?.project_id;
  if (!project_id || !UUID_RE.test(project_id) || !(await projects_repo.exists(project_id))) {
    throw notFound('projects.not_found', `Deployment "${project_id}" was not found`);
  }
  return { project_id };
}
