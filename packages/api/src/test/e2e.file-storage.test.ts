import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';

import { db } from '@api/db/client';
import { deploymentFiles, fileBlobs, files } from '@api/db/schema';

import { hash_content } from '../modules/storage/file-storage';
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
    error_message: 'generation intentionally skipped in file-storage tests',
  }));
});

afterEach(async () => {
  await workflows_queue.idle();
  clear_workflow_generation_mock();
});

const SHARED = 'def run(req):\n    return req\n';

async function create_project(email: string) {
  const token = await authenticate(email);
  const headers = bearer(token);
  const created = await api.projects.post(
    {
      name: 'Storage Demo',
      files: [
        { path: 'workflow.py', content: SHARED },
        { path: 'copy.py', content: SHARED },
        { path: 'other.py', content: '# a different agent\n' },
      ],
    },
    { headers }
  );
  await workflows_queue.idle();
  const project_id = created.data?.project.id;
  if (!project_id) throw new Error('project fixture failed');
  return { token, headers, project_id };
}

describe('content-addressed file storage', () => {
  test('stores identical content once and addresses every file by hash', async () => {
    const { project_id } = await create_project('storage-dedup@cc-forge.test');

    const rows = await db
      .select({ path: files.path, content_hash: files.content_hash })
      .from(files)
      .where(eq(files.project_id, project_id));

    const by_path = new Map(rows.map((row) => [row.path, row.content_hash]));
    expect(by_path.get('workflow.py')).toBe(hash_content(SHARED));
    expect(by_path.get('copy.py')).toBe(hash_content(SHARED));
    expect(by_path.get('other.py')).not.toBe(hash_content(SHARED));

    const distinct = new Set(rows.map((row) => row.content_hash));
    expect(distinct.size).toBe(2);
    for (const hash of distinct) {
      const [blob] = await db.select().from(fileBlobs).where(eq(fileBlobs.content_hash, hash));
      expect(blob?.content_hash).toBe(hash);
    }
  });

  test('serves the current project files with bytes to the runtime endpoint', async () => {
    const { project_id } = await create_project('storage-runtime@cc-forge.test');

    const response = await api.internal.projects[project_id]!.files.get();
    expect(response.status).toBe(200);
    const list = response.data ?? [];
    expect(list.map((file) => file.path)).toEqual(['copy.py', 'other.py', 'workflow.py']);
    expect(list.find((file) => file.path === 'workflow.py')).toMatchObject({
      content: SHARED,
      component_kind: 'workflow',
    });
    expect(list.find((file) => file.path === 'other.py')?.component_kind).toBe('agent');
  });

  test('serves raw bytes by content hash and 404s an unknown hash', async () => {
    await create_project('storage-blob@cc-forge.test');

    const hash = hash_content(SHARED);
    const found = await api.internal.blobs[hash]!.get();
    expect(found.status).toBe(200);
    expect(found.data).toBe(SHARED);

    const missing = await api.internal.blobs['0'.repeat(64)]!.get();
    expect(missing.status).toBe(404);

    const malformed = await api.internal.blobs['not-a-hash']!.get();
    expect(malformed.status).toBeGreaterThanOrEqual(400);
  });

  test('re-hashes and re-stores on edit, keeping content readable', async () => {
    const { headers, project_id } = await create_project('storage-edit@cc-forge.test');

    const listing = await api.projects[project_id]!.files.get({ $headers: headers });
    const workflow = listing.data?.find((file) => file.path === 'workflow.py');
    if (!workflow) throw new Error('workflow file missing');

    const edited = '# edited body\n';
    const patched = await api.projects[project_id]!.files[workflow.id]!.patch(
      { content: edited },
      { headers }
    );
    expect(patched.data?.content).toBe(edited);

    const [row] = await db
      .select({ content_hash: files.content_hash })
      .from(files)
      .where(eq(files.id, workflow.id));
    expect(row?.content_hash).toBe(hash_content(edited));

    const reread = await api.internal.blobs[hash_content(edited)]!.get();
    expect(reread.data).toBe(edited);
  });

  test('records an immutable per-deploy manifest of path to content hash', async () => {
    const { token, headers, project_id } = await create_project('storage-manifest@cc-forge.test');
    await create_deploy_setup(token);

    const accepted = await api.projects[project_id]!.deploy.post({}, { headers });
    const deploy_id = accepted.data?.deploy_id;
    if (!deploy_id) throw new Error(`deploy was not accepted: ${JSON.stringify(accepted.error)}`);

    const manifest = await db
      .select({ path: deploymentFiles.path, content_hash: deploymentFiles.content_hash })
      .from(deploymentFiles)
      .where(eq(deploymentFiles.deployment_id, deploy_id));

    const by_path = new Map(manifest.map((row) => [row.path, row.content_hash]));
    expect([...by_path.keys()].sort()).toEqual(['copy.py', 'other.py', 'workflow.py']);
    expect(by_path.get('workflow.py')).toBe(hash_content(SHARED));

    const via_endpoint = await api.internal.deployments[deploy_id]!.files.get();
    expect(via_endpoint.status).toBe(200);
    expect(via_endpoint.data?.find((file) => file.path === 'workflow.py')?.content).toBe(SHARED);
  });
});
