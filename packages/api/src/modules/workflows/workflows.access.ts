// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { workflows_repo } from './workflows.repo';
import { workflow_not_found } from './workflows.service';

/**
 * Shared `resolve` for every dashboard route under a workflow group's workflow (requests,
 * metrics, monitoring and the rest): 404 unless the workflow exists and runs in that workflow
 * group. `apiKeyGuard` has checked the key before the request got here.
 */
export async function resolve_group_workflow_access({
  params,
}: {
  params: { workflow_group_id: string; workflow_id: string };
}): Promise<{ workflow_id: string }> {
  const { workflow_group_id, workflow_id } = params;
  if ((await workflows_repo.workflow_group_id(workflow_id)) !== workflow_group_id.toLowerCase()) {
    throw workflow_not_found(workflow_id);
  }
  return { workflow_id };
}
