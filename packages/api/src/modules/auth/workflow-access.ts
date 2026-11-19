// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { notFound } from '@core/errors';

import { workflows_repo } from '../workflows/workflows.repo';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Shared `resolve` for every workflow-scoped route (workflows, requests, metrics).
 * The API key covers the whole install, so every verified caller reaches every workflow and only
 * a workflow that does not exist is a 404. It authenticates nothing itself, so mount it after
 * `authPlugin`.
 */
export async function resolveWorkflowAccess({
  params,
}: {
  params: { workflow_id?: string } & Record<string, unknown>;
}): Promise<{ workflow_id: string }> {
  const workflow_id = params?.workflow_id;
  if (!workflow_id || !UUID_RE.test(workflow_id) || !(await workflows_repo.exists(workflow_id))) {
    throw notFound('workflows.not_found', `Workflow "${workflow_id}" was not found`);
  }
  return { workflow_id };
}
