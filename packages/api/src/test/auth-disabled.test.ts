// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test';

import { db } from '@api/db/client';
import { projects } from '@api/db/schema';

import { api, setupE2ETests } from './e2e.setup';
import { seed_active_agents, seed_running_project } from './redis-test.utils';
import type { ScalingPolicy } from '../modules/scaling/scaling.types';

setupE2ETests();

const RANGE_TO = new Date();

const RANGE = {
  from: new Date(RANGE_TO.getTime() - 365 * 86_400_000).toISOString(),
  to: RANGE_TO.toISOString(),
};

const STALE_BEARER = { authorization: 'Bearer x.y.z' };

const POLICY: ScalingPolicy = {
  min_replicas: 1,
  max_replicas: 3,
  metric: 'requests_per_minute_per_replica',
  scale_up_above: 10,
  scale_down_below: 1,
};

async function open_project(name: string): Promise<string> {
  const [project] = await db.insert(projects).values({ name }).returning({ id: projects.id });
  await seed_running_project(project!.id, { prompts: {} });
  await seed_active_agents(JSON.stringify(['app.Alpha']));
  return project!.id;
}

describe('AUTH_DISABLED=true', () => {
  test('/auth/status reports verification off', async () => {
    const status = await api.auth.status.get();

    expect(status.data).toEqual({ disabled: true });
  });

  test('/auth/token answers what a write token would, with no token', async () => {
    const token = await api.auth.token.get();

    expect(token.data).toEqual({ scope: 'write', expires_at: null });
  });

  test('a caller with no token lists projects and changes scaling', async () => {
    const project_id = await open_project('Unsigned Writes');

    const listed = await api.projects.get();
    expect(listed.error).toBeNull();
    expect(listed.data!.map(({ id }) => id)).toContain(project_id);

    const saved = await api.projects[project_id]!.scaling.app!.put(POLICY);
    expect(saved.error).toBeNull();
  });

  // A bearer left in a browser from before the switch was flipped must not turn into a 401.
  test('a stale or forged bearer is ignored', async () => {
    const project_id = await open_project('Stale Bearer');

    const listed = await api.projects.get({ $headers: STALE_BEARER });
    expect(listed.error).toBeNull();
    expect(listed.data!.map(({ id }) => id)).toContain(project_id);

    const saved = await api.projects[project_id]!.scaling.app!.put(POLICY, {
      headers: STALE_BEARER,
    });
    expect(saved.error).toBeNull();
  });

  // The resolver is wired per plugin (projects / requests / metrics / monitoring / prompts / scaling),
  // so reaching every sub-resource proves each composed plugin serves a caller with no headers.
  test('a caller with no headers lists the projects and reaches every sub-resource', async () => {
    const project_id = await open_project('Open Project');

    const listed = await api.projects.get();
    expect(listed.error).toBeNull();
    expect(listed.data!.map(({ id }) => id)).toContain(project_id);

    const responses = await Promise.all([
      api.projects[project_id]!.get(),
      api.projects[project_id]!.stats.get(),
      api.projects[project_id]!.requests.get({ $query: { ...RANGE, limit: 20, offset: 0 } }),
      api.projects[project_id]!.metrics.kpis.get({ $query: RANGE }),
      api.projects[project_id]!.monitoring.series.get({ $query: RANGE }),
      api.projects[project_id]!.monitoring.logs.get({
        $query: { ...RANGE, limit: 200, errors_only: false },
      }),
      api.projects[project_id]!.monitoring.traces.get({ $query: { ...RANGE, limit: 200 } }),
      api.projects[project_id]!.monitoring.resources.get({ $query: RANGE }),
      api.projects[project_id]!.monitoring.replicas.get(),
      api.projects[project_id]!.monitoring.endpoint.get(),
      api.projects[project_id]!.prompts.get(),
      api.projects[project_id]!.scaling.get(),
    ]);

    for (const res of responses) {
      expect(res.error).toBeNull();
    }
  });

  test('a project id that does not exist is 404 projects.not_found', async () => {
    const unknown = '00000000-0000-4000-8000-000000000000';

    const res = await api.projects[unknown]!.stats.get();

    expect(res.error?.status as number).toBe(404);
    expect((res.error?.value as { error?: string })?.error).toBe('projects.not_found');
  });
});
