// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { db } from '@api/db/client';
import { workflows } from '@api/db/schema';

export { TEST_API_KEY } from './api-key-test.utils';

export const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

export interface TestWorkflow {
  readonly workflow_id: string;
}

/**
 * Seeds a workflow straight into the database, the way the self-host bootstrap does, since the API
 * no longer creates workflows, as the one workflow of a workflow group with its id.
 */
export async function create_test_workflow({ name }: { name: string }): Promise<TestWorkflow> {
  return db.transaction(async (tx) => {
    const id = crypto.randomUUID();
    const [workflow] = await tx
      .insert(workflows)
      .values({ id, name, workflow_group_id: id })
      .returning({ id: workflows.id });
    if (!workflow) throw new Error('Workflow fixture was not created');
    return { workflow_id: workflow.id };
  });
}
