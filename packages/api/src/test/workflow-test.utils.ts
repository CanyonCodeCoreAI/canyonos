// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { db } from '@api/db/client';
import { workflowGroups, workflows } from '@api/db/schema';

import { hashApiKey, TEST_API_KEY } from './api-key-test.utils';

export { TEST_API_KEY, TEST_DEPLOY_KEY } from './api-key-test.utils';

export const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

export interface TestWorkflow {
  readonly workflow_id: string;
  readonly workflow_group_id: string;
}

/** The row of a workflow group, as a deploy leaves it, with the hash of `api_key`, or none for an
 * open one; its id, a new one unless given. */
export async function create_test_workflow_group({
  id = crypto.randomUUID(),
  api_key = TEST_API_KEY,
}: { id?: string; api_key?: string | null } = {}): Promise<string> {
  await db.insert(workflowGroups).values({
    id,
    name: 'test',
    config: 'target: docker\n',
    api_key_hash: api_key === null ? null : hashApiKey(api_key),
  });
  return id;
}

/**
 * Seeds a workflow straight into the database, the way the self-host bootstrap does, since the API
 * no longer creates workflows: by default as the one workflow of a new workflow group with its id
 * and the key `api_key` (TEST_API_KEY; null for an open one), else in `workflow_group_id`, whose
 * row the caller made, or made none of.
 */
export async function create_test_workflow({
  name,
  api_key = TEST_API_KEY,
  workflow_group_id,
  created_at,
}: {
  name: string;
  api_key?: string | null;
  workflow_group_id?: string;
  created_at?: string;
}): Promise<TestWorkflow> {
  const id = crypto.randomUUID();
  const group_id = workflow_group_id ?? (await create_test_workflow_group({ id, api_key }));
  const [workflow] = await db
    .insert(workflows)
    .values({
      id,
      name,
      workflow_group_id: group_id,
      ...(created_at ? { created_at, updated_at: created_at } : {}),
    })
    .returning({ id: workflows.id });
  if (!workflow) throw new Error('Workflow fixture was not created');
  return { workflow_id: workflow.id, workflow_group_id: group_id };
}
