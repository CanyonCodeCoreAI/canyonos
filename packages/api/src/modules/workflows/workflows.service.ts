// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { conflict, notFound } from '@core/errors';

import { assert_workflow_running, with_redis } from '../canyonos/canyonos.redis';
import { workflows_repo } from './workflows.repo';
import type { WorkflowDeleted, WorkflowStats, WorkflowSummary } from './workflows.types';

function workflow_not_found(workflow_id: string) {
  return notFound('workflows.not_found', `Workflow "${workflow_id}" was not found`);
}

export async function list_workflows(): Promise<WorkflowSummary[]> {
  return workflows_repo.list_with_counts();
}

export async function get_workflow(workflow_id: string): Promise<WorkflowSummary> {
  const workflow = await workflows_repo.get_with_count(workflow_id);
  if (!workflow) throw workflow_not_found(workflow_id);
  return workflow;
}

export async function get_workflow_stats(workflow_id: string): Promise<WorkflowStats> {
  const counts = await workflows_repo.get_component_counts(workflow_id);
  if (!counts) throw workflow_not_found(workflow_id);
  return { workflow_id, ...counts };
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
