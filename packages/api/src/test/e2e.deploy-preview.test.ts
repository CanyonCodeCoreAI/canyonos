import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';

import { db } from '@api/db/client';
import { deployments, fileBlobs, files } from '@api/db/schema';

import { blob_store } from '../modules/storage/file-storage';
import {
  clear_workflow_generation_mock,
  set_workflow_generation_mock,
} from '../modules/workflows/workflows.generation.testkit';
import { workflows_queue } from '../modules/workflows/workflows.queue';
import { api, setupE2ETests } from './e2e.setup';
import { authenticate, bearer, create_deploy_setup } from './project-test.utils';

setupE2ETests();

beforeEach(() => {
  set_workflow_generation_mock(async () => ({
    status: 'failed',
    error_message: 'generation intentionally skipped in deploy-preview tests',
  }));
});

afterEach(async () => {
  await workflows_queue.idle();
  clear_workflow_generation_mock();
});

const WORKFLOW = 'line1\nline2\nline3\n';
const HELPER = 'shared helper\n';
const OLD = 'to be removed\n';

async function setup_project(email: string) {
  const token = await authenticate(email);
  const headers = bearer(token);
  await create_deploy_setup(token);
  const profile = await api.auth.profile.get({ $headers: headers });
  const company_id = profile.data?.company_id;
  const user_id = profile.data?.id;
  const created = await api.projects.post(
    {
      name: 'Preview Demo',
      files: [
        { path: 'workflow.py', content: WORKFLOW },
        { path: 'helper.py', content: HELPER },
        { path: 'old.py', content: OLD },
      ],
    },
    { headers }
  );
  await workflows_queue.idle();
  const project_id = created.data?.project.id;
  if (!project_id || !company_id || !user_id) throw new Error('preview fixture failed');
  return { token, headers, project_id, company_id, user_id };
}

async function deploy_to_success(project_id: string, headers: ReturnType<typeof bearer>) {
  const accepted = await api.projects[project_id]!.deploy.post({}, { headers });
  const deploy_id = accepted.data?.deploy_id;
  if (!deploy_id) throw new Error(`deploy not accepted: ${JSON.stringify(accepted.error)}`);

  for (let attempt = 0; attempt < 400; attempt += 1) {
    const [row] = await db
      .select({ status: deployments.status })
      .from(deployments)
      .where(eq(deployments.id, deploy_id));
    if (row?.status === 'success') return deploy_id;
    if (row?.status === 'failed') throw new Error('deploy failed unexpectedly');
    await Bun.sleep(5);
  }
  throw new Error(`deploy ${deploy_id} never reached success`);
}

async function insert_file(
  company_id: string,
  user_id: string,
  project_id: string,
  path: string,
  content: string
) {
  const content_hash = await blob_store.put(content);
  await db
    .insert(fileBlobs)
    .values({ content_hash, byte_size: content.length })
    .onConflictDoNothing();
  await db.insert(files).values({
    company_id,
    project_id,
    created_by: user_id,
    path,
    name: path,
    content_hash,
    language: 'python',
    byte_size: content.length,
    component_kind: 'agent',
  });
}

describe('deploy preview', () => {
  test('reports every current file as added when there is no successful deployment', async () => {
    const { headers, project_id } = await setup_project('preview-fresh@cc-forge.test');

    const response = await api.projects[project_id]!.deploy.preview.get({ $headers: headers });
    expect(response.status).toBe(200);
    const preview = response.data!;

    expect(preview.base_deployment_id).toBeNull();
    expect(preview.base_created_at).toBeNull();
    expect(preview.has_changes).toBe(true);
    expect(preview.summary).toEqual({ added: 3, removed: 0, modified: 0 });
    expect(preview.files.map((file) => file.path)).toEqual(['helper.py', 'old.py', 'workflow.py']);
    expect(preview.files.every((file) => file.change === 'added')).toBe(true);

    const workflow = preview.files.find((file) => file.path === 'workflow.py')!;
    expect(workflow.rows).toEqual([
      { kind: 'added', old_line: null, new_line: 1, old_text: null, new_text: 'line1' },
      { kind: 'added', old_line: null, new_line: 2, old_text: null, new_text: 'line2' },
      { kind: 'added', old_line: null, new_line: 3, old_text: null, new_text: 'line3' },
    ]);
  });

  test('reports no changes right after a successful deployment with no edits', async () => {
    const { headers, project_id } = await setup_project('preview-clean@cc-forge.test');
    const deploy_id = await deploy_to_success(project_id, headers);

    const response = await api.projects[project_id]!.deploy.preview.get({ $headers: headers });
    expect(response.status).toBe(200);
    const preview = response.data!;

    expect(preview.base_deployment_id).toBe(deploy_id);
    expect(preview.base_created_at).not.toBeNull();
    expect(preview.has_changes).toBe(false);
    expect(preview.files).toEqual([]);
    expect(preview.summary).toEqual({ added: 0, removed: 0, modified: 0 });
  });

  test('classifies edited, added, and deleted files against the last successful deployment', async () => {
    const { headers, project_id, company_id, user_id } = await setup_project(
      'preview-changes@cc-forge.test'
    );
    const deploy_id = await deploy_to_success(project_id, headers);

    const listing = await api.projects[project_id]!.files.get({ $headers: headers });
    const list = listing.data ?? [];
    const workflow = list.find((file) => file.path === 'workflow.py')!;
    const removed = list.find((file) => file.path === 'old.py')!;

    await api.projects[project_id]!.files[workflow.id]!.patch(
      { content: 'line1\nCHANGED\nline3\n' },
      { headers }
    );
    await api.projects[project_id]!.files[removed.id]!.delete(undefined, { headers });
    await insert_file(company_id, user_id, project_id, 'new.py', 'brand new\n');
    await workflows_queue.idle();

    const response = await api.projects[project_id]!.deploy.preview.get({ $headers: headers });
    expect(response.status).toBe(200);
    const preview = response.data!;

    expect(preview.base_deployment_id).toBe(deploy_id);
    expect(preview.has_changes).toBe(true);
    expect(preview.summary).toEqual({ added: 1, removed: 1, modified: 1 });
    expect(preview.files.map((file) => ({ path: file.path, change: file.change }))).toEqual([
      { path: 'new.py', change: 'added' },
      { path: 'old.py', change: 'removed' },
      { path: 'workflow.py', change: 'modified' },
    ]);

    const modified = preview.files.find((file) => file.path === 'workflow.py')!;
    expect(modified.rows).toEqual([
      { kind: 'unchanged', old_line: 1, new_line: 1, old_text: 'line1', new_text: 'line1' },
      { kind: 'changed', old_line: 2, new_line: 2, old_text: 'line2', new_text: 'CHANGED' },
      { kind: 'unchanged', old_line: 3, new_line: 3, old_text: 'line3', new_text: 'line3' },
    ]);

    const added = preview.files.find((file) => file.path === 'new.py')!;
    expect(added.rows).toEqual([
      { kind: 'added', old_line: null, new_line: 1, old_text: null, new_text: 'brand new' },
    ]);
  });

  test('lets a user from another company preview the project', async () => {
    const { project_id } = await setup_project('preview-owner@cc-forge.test');
    const other_company = await authenticate('preview-intruder@cc-forge.test');

    const response = await api.projects[project_id]!.deploy.preview.get({
      $headers: bearer(other_company),
    });
    expect(response.error).toBeNull();
    expect(response.data!.files.map((file) => file.path)).toContain('workflow.py');
  });

  test('answers 404 for a project id that does not exist', async () => {
    const token = await authenticate('preview-unknown@cc-forge.test');
    const unknown = '00000000-0000-4000-8000-000000000000';

    const response = await api.projects[unknown]!.deploy.preview.get({ $headers: bearer(token) });

    expect(response.error?.status as number).toBe(404);
    expect((response.error?.value as { error?: string })?.error).toBe('projects.not_found');
  });
});
