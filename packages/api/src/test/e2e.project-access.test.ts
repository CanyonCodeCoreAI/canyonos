import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  clear_workflow_generation_mock,
  set_workflow_generation_mock,
} from '../modules/workflows/workflows.generation.testkit';
import { workflows_queue } from '../modules/workflows/workflows.queue';
import { api, setupE2ETests } from './e2e.setup';
import { authenticate, bearer } from './project-test.utils';

setupE2ETests();

beforeEach(() => {
  set_workflow_generation_mock(async () => ({ status: 'failed', error_message: 'access test' }));
});

afterEach(async () => {
  await workflows_queue.idle();
  clear_workflow_generation_mock();
});

async function create_project(token: string): Promise<string> {
  const project = await api.projects.post(
    { name: 'Access Project', files: [{ path: 'workflow.py', content: 'def run(): pass\n' }] },
    { headers: bearer(token) }
  );
  expect(project.error).toBeNull();
  return project.data!.project.id;
}

describe('project access across the /projects tree', () => {
  test('the creator reaches its sub-resources', async () => {
    const token = await authenticate('access-creator@cc-forge.test');
    const project_id = await create_project(token);

    const detail = await api.projects[project_id]!.get({ $headers: bearer(token) });
    expect(detail.error).toBeNull();
    expect(detail.data?.id).toBe(project_id);
  });

  // The resolver is wired per plugin (projects / workflows / deploy / requests / metrics), so
  // reaching every sub-resource proves the new rule fires in each composed plugin.
  test('a user from another company reaches every project sub-resource', async () => {
    const owner = await authenticate('access-owner2@cc-forge.test');
    const project_id = await create_project(owner);

    const other = await authenticate('access-other@cc-forge.test');
    const read = { $headers: bearer(other) };

    const responses = await Promise.all([
      api.projects[project_id]!.get(read),
      api.projects[project_id]!.status.get(read),
      api.projects[project_id]!.stats.get(read),
      api.projects[project_id]!.files.get(read),
      api.projects[project_id]!.workflows.get(read),
      api.projects[project_id]!.deploy.summary.get(read),
      api.projects[project_id]!.requests.get({ ...read, $query: { limit: 20, offset: 0 } }),
      api.projects[project_id]!.metrics.kpis.get(read),
    ]);

    for (const res of responses) {
      expect(res.error).toBeNull();
    }
    expect(await api.projects.get(read)).toMatchObject({ error: null });
    expect((await api.projects.get(read)).data!.map(({ id }) => id)).toContain(project_id);
  });

  test('a project id that does not exist is 404 projects.not_found for any caller', async () => {
    const token = await authenticate('access-missing@cc-forge.test');
    const unknown = '00000000-0000-4000-8000-000000000000';

    const res = await api.projects[unknown]!.status.get({ $headers: bearer(token) });

    expect(res.error?.status as number).toBe(404);
    expect((res.error?.value as { error?: string })?.error).toBe('projects.not_found');
  });

  test('a caller with no token is rejected before the project is resolved', async () => {
    const owner = await authenticate('access-anon-owner@cc-forge.test');
    const project_id = await create_project(owner);

    expect((await api.projects[project_id]!.get()).error?.status as number).toBe(401);
    expect((await api.projects.get()).error?.status as number).toBe(401);
  });
});
