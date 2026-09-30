import { expect } from 'bun:test';
import { eq } from 'drizzle-orm';

import { db } from '@api/db/client';
import { fileBlobs, files, projects, projectWorkflows, users } from '@api/db/schema';

import { api } from './e2e.setup';

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

export async function authenticate(email: string, onboard = true): Promise<string> {
  await api.auth.challenge.post({ email });
  const verify = await api.auth.verify.post({ email, code: '111111' });
  expect(verify.error).toBeNull();
  const token = verify.data?.token;
  if (!token) throw new Error(`Authentication failed for ${email}`);
  if (onboard) {
    await api.onboarding.create.post(
      { company_name: `Company for ${email}` },
      { headers: bearer(token) }
    );
  }
  return token;
}

export async function add_company_member(owner_token: string, email: string): Promise<string> {
  const token = await authenticate(email, false);
  const owner = await api.auth.profile.get({ $headers: bearer(owner_token) });
  const member = await api.auth.profile.get({ $headers: bearer(token) });
  const company_id = owner.data?.company_id;
  const member_id = member.data?.id;
  if (!company_id || !member_id) throw new Error('Company member fixture could not be created');
  await db
    .update(users)
    .set({ companyId: company_id, status: 'ACTIVE' })
    .where(eq(users.id, member_id));
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
 * Seeds a project owned by the caller's company straight into the database, the way the self-host
 * bootstrap does, since the API no longer creates projects. Each workflow file gets a PENDING
 * workflow row so project stats have something to count.
 */
export async function create_test_project(
  token: string,
  { name, files: project_files = [] }: { name: string; files?: readonly TestProjectFile[] }
): Promise<TestProject> {
  const profile = await api.auth.profile.get({ $headers: bearer(token) });
  const company_id = profile.data?.company_id;
  const created_by = profile.data?.id;
  if (!company_id || !created_by) throw new Error('Project fixture could not resolve a company');

  return db.transaction(async (tx) => {
    const [project] = await tx
      .insert(projects)
      .values({ company_id, created_by, name })
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
          company_id,
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
