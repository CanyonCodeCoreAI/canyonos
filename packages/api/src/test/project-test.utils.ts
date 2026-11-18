// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { db } from '@api/db/client';
import { fileBlobs, files, projects, projectWorkflows } from '@api/db/schema';

export { TEST_API_KEY } from './api-key-test.utils';

export const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

export type TestFileKind = (typeof files.$inferInsert)['component_kind'];

export interface TestProjectFile {
  readonly path: string;
  readonly component_kind: TestFileKind;
}

export interface TestProject {
  readonly project_id: string;
  readonly workflow_ids: string[];
}

/**
 * Seeds a project straight into the database, the way the self-host bootstrap does, since the API
 * no longer creates projects. Each workflow file gets a PENDING workflow row so project stats have
 * something to count.
 */
export async function create_test_project({
  name,
  files: project_files = [],
}: {
  name: string;
  files?: readonly TestProjectFile[];
}): Promise<TestProject> {
  return db.transaction(async (tx) => {
    const [project] = await tx.insert(projects).values({ name }).returning({ id: projects.id });
    if (!project) throw new Error('Project fixture was not created');

    const workflow_ids: string[] = [];
    for (const { path, component_kind } of project_files) {
      const content_hash = new Bun.CryptoHasher('sha256').update(path).digest('hex');
      await tx
        .insert(fileBlobs)
        .values({ content_hash, byte_size: path.length })
        .onConflictDoNothing();
      const [file] = await tx
        .insert(files)
        .values({
          project_id: project.id,
          path,
          name: path.split('/').at(-1) ?? path,
          content_hash,
          language: path.endsWith('.py') ? 'python' : 'text',
          byte_size: path.length,
          component_kind,
        })
        .returning({ id: files.id });
      if (!file) throw new Error(`Project fixture file ${path} was not created`);
      if (component_kind !== 'workflow') continue;

      const [workflow] = await tx
        .insert(projectWorkflows)
        .values({ project_id: project.id, source_file_id: file.id })
        .returning({ id: projectWorkflows.id });
      if (workflow) workflow_ids.push(workflow.id);
    }
    return { project_id: project.id, workflow_ids };
  });
}
