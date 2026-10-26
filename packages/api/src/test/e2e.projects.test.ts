// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, test } from 'bun:test';
import { eq, sql } from 'drizzle-orm';

import { db } from '@api/db/client';
import { otelLogs, otelMetrics, otelSpans, projectWorkflows } from '@api/db/schema';
import { PROJECT_ID_ATTRIBUTE } from '@api/modules/metrics/metrics.contract';
import { RESOURCE_PROJECT_ATTRIBUTE } from '@api/modules/monitoring/monitoring.signals';

import { api, setupE2ETests } from './e2e.setup';
import { authenticate, bearer, create_test_project } from './project-test.utils';
import { reset_controller, seed_running_project } from './redis-test.utils';
import { write_project_span } from './telemetry-test.utils';
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

  test('lets another user list and read a project', async () => {
    const owner = await authenticate('project-owner@canyonos.test');
    const { project_id } = await create_test_project(owner, { name: 'Shared', files: FILES });
    const other_user = await authenticate('project-outsider@canyonos.test');

    for (const token of [owner, other_user]) {
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

async function write_telemetry(project_id: string): Promise<void> {
  await write_project_span(project_id, { span_id: `span-${project_id}` });
  const resource_attributes = { [RESOURCE_PROJECT_ATTRIBUTE]: project_id };
  await db.insert(otelMetrics).values({
    resource_attributes,
    metric_name: 'canyonos.test.gauge',
    metric_type: 'gauge',
    time_unix_nano: 1n,
    value: 1,
  });
  await db
    .insert(otelLogs)
    .values({ resource_attributes, time_unix_nano: 1n, observed_time_unix_nano: 1n, body: 'hi' });
}

/** How many spans, metrics and logs name project_id. */
async function telemetry_counts(project_id: string): Promise<number[]> {
  const count = sql<number>`count(*)::int`;
  const [spans] = await db
    .select({ count })
    .from(otelSpans)
    .where(sql`${otelSpans.attributes} ->> ${PROJECT_ID_ATTRIBUTE} = ${project_id}`);
  const [metrics] = await db
    .select({ count })
    .from(otelMetrics)
    .where(
      sql`${otelMetrics.resource_attributes} ->> ${RESOURCE_PROJECT_ATTRIBUTE} = ${project_id}`
    );
  const [logs] = await db
    .select({ count })
    .from(otelLogs)
    .where(sql`${otelLogs.resource_attributes} ->> ${RESOURCE_PROJECT_ATTRIBUTE} = ${project_id}`);
  return [spans!.count, metrics!.count, logs!.count];
}

describe('DELETE /projects/:project_id', () => {
  beforeEach(reset_controller);

  test('deletes a stopped project and its telemetry, and leaves other projects alone', async () => {
    const token = await authenticate('project-delete@canyonos.test');
    const headers = bearer(token);
    const { project_id } = await create_test_project(token, { name: 'Stopped', files: FILES });
    const { project_id: other_id } = await create_test_project(token, { name: 'Other' });
    await write_telemetry(project_id);
    await write_telemetry(other_id);

    const res = await api.projects[project_id]!.delete(undefined, { headers });
    expect(res.error).toBeNull();
    expect(res.data).toEqual({ project_id });

    const detail = await api.projects[project_id]!.get({ $headers: headers });
    expect(detail.error?.status as number).toBe(404);
    expect(await telemetry_counts(project_id)).toEqual([0, 0, 0]);
    expect(await telemetry_counts(other_id)).toEqual([1, 1, 1]);
  });

  test('refuses a running project with 409 projects.running and keeps it', async () => {
    const token = await authenticate('project-delete-running@canyonos.test');
    const headers = bearer(token);
    const { project_id } = await create_test_project(token, { name: 'Running' });
    await seed_running_project(project_id, { prompts: {} });

    const res = await api.projects[project_id]!.delete(undefined, { headers });
    expect(res.error?.status as number).toBe(409);
    expect((res.error?.value as { error?: string })?.error).toBe('projects.running');

    const detail = await api.projects[project_id]!.get({ $headers: headers });
    expect(detail.data?.id).toBe(project_id);
  });
});
