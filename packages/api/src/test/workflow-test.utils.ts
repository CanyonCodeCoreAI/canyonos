// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { db } from '@api/db/client';
import { fileBlobs, files, workflows } from '@api/db/schema';

export { TEST_API_KEY } from './api-key-test.utils';

export const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

export type TestFileKind = (typeof files.$inferInsert)['component_kind'];

export interface TestWorkflowFile {
  readonly path: string;
  readonly component_kind: TestFileKind;
}

export interface TestWorkflow {
  readonly workflow_id: string;
}

/**
 * Seeds a workflow straight into the database, the way the self-host bootstrap does, since the API
 * no longer creates workflows, as the one workflow of a workflow group with its id.
 */
export async function create_test_workflow({
  name,
  files: workflow_files = [],
}: {
  name: string;
  files?: readonly TestWorkflowFile[];
}): Promise<TestWorkflow> {
  return db.transaction(async (tx) => {
    const id = crypto.randomUUID();
    const [workflow] = await tx
      .insert(workflows)
      .values({ id, name, workflow_group_id: id })
      .returning({ id: workflows.id });
    if (!workflow) throw new Error('Workflow fixture was not created');

    for (const { path, component_kind } of workflow_files) {
      const content_hash = new Bun.CryptoHasher('sha256').update(path).digest('hex');
      await tx
        .insert(fileBlobs)
        .values({ content_hash, byte_size: path.length })
        .onConflictDoNothing();
      await tx.insert(files).values({
        workflow_id: workflow.id,
        path,
        name: path.split('/').at(-1) ?? path,
        content_hash,
        language: path.endsWith('.py') ? 'python' : 'text',
        byte_size: path.length,
        component_kind,
      });
    }
    return { workflow_id: workflow.id };
  });
}
