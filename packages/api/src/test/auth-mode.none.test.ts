// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test';

import { db } from '@api/db/client';
import { projects } from '@api/db/schema';

import { api, setupE2ETests } from './e2e.setup';
import { seed_running_project } from './redis-test.utils';

setupE2ETests();

const RANGE_TO = new Date();

const RANGE = {
  from: new Date(RANGE_TO.getTime() - 365 * 86_400_000).toISOString(),
  to: RANGE_TO.toISOString(),
};

const CREDENTIALS = { email: 'nobody@example.com', password: 'e2e-password-1' };

const expectSignInDisabled = (res: { error: { status: unknown; value: unknown } | null }) => {
  expect(res.error?.status as number).toBe(404);
  expect((res.error?.value as { error?: string })?.error).toBe('auth.disabled');
};

describe('AUTH_MODE=none', () => {
  test('/auth/status reports the mode', async () => {
    const status = await api.auth.status.get();

    expect(status.data).toEqual({ mode: 'none', has_users: false });
  });

  test('register, login and profile are 404 auth.disabled', async () => {
    expectSignInDisabled(
      await api.auth.register.post({ ...CREDENTIALS, password_confirmation: CREDENTIALS.password })
    );
    expectSignInDisabled(await api.auth.login.post(CREDENTIALS));
    expectSignInDisabled(await api.auth.profile.get());
  });

  // The resolver is wired per plugin (projects / requests / metrics / monitoring / prompts / scaling),
  // so reaching every sub-resource proves each composed plugin serves a caller with no headers.
  test('a caller with no headers lists the projects and reaches every sub-resource', async () => {
    const [project] = await db
      .insert(projects)
      .values({ name: 'Open Project' })
      .returning({ id: projects.id });
    const project_id = project!.id;
    await seed_running_project(project_id, { prompts: {} });

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
