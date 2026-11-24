// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { conflict, notFound } from '@core/errors';

import { assert_workflow_running, with_redis } from '../registry/registry.redis';
import { workflows_repo } from './workflows.repo';
import type { WorkflowDeleted, WorkflowSummary } from './workflows.types';

export function workflow_not_found(workflow_id: string) {
  return notFound('workflows.not_found', `Workflow "${workflow_id}" was not found`);
}

/** The workflows of the workflow groups `workflow_group_ids`. */
export async function list_workflows(
  workflow_group_ids: readonly string[]
): Promise<WorkflowSummary[]> {
  return workflows_repo.list(workflow_group_ids);
}

/** The workflow, when it is in one of the workflow groups `workflow_group_ids`; 404 otherwise. */
export async function get_workflow(
  workflow_id: string,
  workflow_group_ids: readonly string[]
): Promise<WorkflowSummary> {
  const workflow = await workflows_repo.get(workflow_id, workflow_group_ids);
  if (!workflow) throw workflow_not_found(workflow_id);
  return workflow;
}

// A workflow whose Redis can't be reached counts as stopped: stopping it removes that Redis.
export async function delete_workflow(workflow_id: string): Promise<WorkflowDeleted> {
  const running = await with_redis(workflow_id, (redis) =>
    assert_workflow_running(redis, workflow_id)
  ).then(
    () => true,
    () => false
  );
  if (running) {
    throw conflict(
      'workflows.running',
      'This workflow is still running. Run `canyonos stop` in its folder, then delete it.'
    );
  }
  await workflows_repo.delete(workflow_id);
  return { workflow_id };
}
