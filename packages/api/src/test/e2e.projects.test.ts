import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';

import { db } from '@api/db/client';
import { projectWorkflows } from '@api/db/schema';

import { api, setupE2ETests } from './e2e.setup';
import {
  add_company_member,
  authenticate,
  bearer,
  create_test_project,
} from './project-test.utils';
import type { TestProjectFile } from './project-test.utils';

setupE2ETests();

const FILES: TestProjectFile[] = [
  { path: 'workflow.py', component_kind: 'workflow' },
  { path: 'nested/sales_workflow.py', component_kind: 'workflow' },
  { path: 'agents/router.agent.py', component_kind: 'agent' },
  { path: 'nested/agent.py', component_kind: 'agent' },
  { path: 'tools/search.tool.py', component_kind: 'tool' },
  { path: 'README.md', component_kind: 'other' },
];

describe('project list and detail', () => {
  test('lists and reads a project with its file count', async () => {
    const token = await authenticate('project-list@canyonos.test');
    const headers = bearer(token);
    const { project_id } = await create_test_project(token, { name: 'Demo Flow', files: FILES });

    const list = await api.projects.get({ $headers: headers });
    expect(list.error).toBeNull();
    expect(list.data?.find(({ id }) => id === project_id)).toMatchObject({
      name: 'Demo Flow',
      file_count: FILES.length,
    });

    const detail = await api.projects[project_id]!.get({ $headers: headers });
    expect(detail.error).toBeNull();
    expect(detail.data).toMatchObject({ id: project_id, name: 'Demo Flow', file_count: 6 });
  });

  test('a project with no files reports a zero file count', async () => {
    const token = await authenticate('project-empty@canyonos.test');
    const { project_id } = await create_test_project(token, { name: 'Empty' });

    const detail = await api.projects[project_id]!.get({ $headers: bearer(token) });
    expect(detail.data?.file_count).toBe(0);
  });

  test('lets a company member and a user from another company list and read a project', async () => {
    const owner = await authenticate('project-owner@canyonos.test');
    const { project_id } = await create_test_project(owner, { name: 'Shared', files: FILES });
    const member = await add_company_member(owner, 'project-member@canyonos.test');
    const other_company = await authenticate('project-outsider@canyonos.test');

    for (const token of [member, other_company]) {
      const list = await api.projects.get({ $headers: bearer(token) });
      expect(list.data?.some(({ id }) => id === project_id)).toBe(true);
      const detail = await api.projects[project_id]!.get({ $headers: bearer(token) });
      expect(detail.data?.id).toBe(project_id);
    }
  });

  test('returns 404 projects.not_found for an unknown project', async () => {
    const token = await authenticate('project-unknown@canyonos.test');
    const unknown = '00000000-0000-4000-8000-000000000000';

    const res = await api.projects[unknown]!.get({ $headers: bearer(token) });
    expect(res.error?.status as number).toBe(404);
    expect((res.error?.value as { error?: string })?.error).toBe('projects.not_found');
  });

  test('rejects unauthenticated access', async () => {
    expect((await api.projects.get()).error?.status as number).toBe(401);
  });
});

describe('GET /projects/:project_id/stats', () => {
  test('counts files by component kind and workflows by readiness', async () => {
    const token = await authenticate('project-stats@canyonos.test');
    const headers = bearer(token);
    const { project_id, workflow_ids } = await create_test_project(token, {
      name: 'Stats',
      files: FILES,
    });

    const pending = await api.projects[project_id]!.stats.get({ $headers: headers });
    expect(pending.error).toBeNull();
    expect(pending.data).toEqual({
      project_id,
      file_count: 6,
      agent_count: 2,
      tool_count: 1,
      workflow_count: 2,
      ready_workflow_count: 0,
    });

    await db
      .update(projectWorkflows)
      .set({ generation_status: 'READY', design: { nodes: [], edges: [] } })
      .where(eq(projectWorkflows.id, workflow_ids[0]!));

    const ready = await api.projects[project_id]!.stats.get({ $headers: headers });
    expect(ready.data?.ready_workflow_count).toBe(1);
  });

  test('a stale READY workflow is not counted as ready', async () => {
    const token = await authenticate('project-stats-stale@canyonos.test');
    const { project_id, workflow_ids } = await create_test_project(token, {
      name: 'Stale Stats',
      files: [{ path: 'workflow.py', component_kind: 'workflow' }],
    });

    await db
      .update(projectWorkflows)
      .set({
        generation_status: 'READY',
        design: { nodes: [], edges: [] },
        stale_at: new Date().toISOString(),
      })
      .where(eq(projectWorkflows.id, workflow_ids[0]!));

    const stats = await api.projects[project_id]!.stats.get({ $headers: bearer(token) });
    expect(stats.data).toMatchObject({ workflow_count: 1, ready_workflow_count: 0 });
  });

  test('a project with no files reports zero counts', async () => {
    const token = await authenticate('project-stats-empty@canyonos.test');
    const { project_id } = await create_test_project(token, { name: 'Empty Stats' });

    const stats = await api.projects[project_id]!.stats.get({ $headers: bearer(token) });
    expect(stats.data).toEqual({
      project_id,
      file_count: 0,
      agent_count: 0,
      tool_count: 0,
      workflow_count: 0,
      ready_workflow_count: 0,
    });
  });

  test('rejects unauthenticated access', async () => {
    const token = await authenticate('project-stats-unauth@canyonos.test');
    const { project_id } = await create_test_project(token, { name: 'Unauth Stats' });

    expect((await api.projects[project_id]!.stats.get()).error?.status as number).toBe(401);
  });
});
