// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { expect } from 'bun:test';

import { db } from '@api/db/client';
import { fileBlobs, files, projects, projectWorkflows, users } from '@api/db/schema';
import { hashPassword } from '@api/modules/auth/lib/password';

import { api } from './e2e.setup';

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

export const TEST_PASSWORD = 'e2e-password-1';

/** Seeds an account straight into the database, since registration only creates the first one. */
export async function create_test_user(email: string): Promise<void> {
  await db
    .insert(users)
    .values({ email, password_hash: await hashPassword(TEST_PASSWORD) })
    .onConflictDoNothing();
}

/** Logs the email in, creating its account first when it does not exist yet. */
export async function authenticate(email: string): Promise<string> {
  const credentials = { email, password: TEST_PASSWORD };
  let res = await api.auth.login.post(credentials);
  if ((res.error?.status as number) === 401) {
    if ((await api.auth.status.get()).data?.has_users === false) {
      res = await api.auth.register.post({ ...credentials, password_confirmation: TEST_PASSWORD });
    } else {
      await create_test_user(email);
      res = await api.auth.login.post(credentials);
    }
  }
  expect(res.error).toBeNull();
  const token = res.data?.token;
  if (!token) throw new Error(`Authentication failed for ${email}`);
  return token;
}

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
 * Seeds a project created by the caller straight into the database, the way the self-host
 * bootstrap does, since the API no longer creates projects. Each workflow file gets a PENDING
 * workflow row so project stats have something to count.
 */
export async function create_test_project(
  token: string,
  { name, files: project_files = [] }: { name: string; files?: readonly TestProjectFile[] }
): Promise<TestProject> {
  const profile = await api.auth.profile.get({ $headers: bearer(token) });
  const created_by = profile.data?.id;
  if (!created_by) throw new Error('Project fixture could not resolve the caller');

  return db.transaction(async (tx) => {
    const [project] = await tx
      .insert(projects)
      .values({ created_by, name })
      .returning({ id: projects.id });
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
          created_by,
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
