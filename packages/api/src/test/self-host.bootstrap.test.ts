// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';

import { db } from '@api/db/client';
import { projects, users } from '@api/db/schema';
import {
  bootstrap_canyonos,
  save_controller_project,
} from '@api/modules/canyonos/canyonos.bootstrap';
import { config } from '@core/env';

import { api, setupE2ETests } from './e2e.setup';
import { authenticate, bearer, create_test_user } from './project-test.utils';
import { write_project_span } from './telemetry-test.utils';

setupE2ETests();

const REDIS_PORT = 6380;
const NOW_NANOS = BigInt(Date.now()) * 1_000_000n;
const MINUTE_NANOS = 60_000_000_000n;

const count_projects = async (): Promise<number> =>
  (await db.select({ id: projects.id }).from(projects)).length;

const count_users = async (): Promise<number> =>
  (await db.select({ id: users.id }).from(users)).length;

async function read_project(project_id: string) {
  const [row] = await db.select().from(projects).where(eq(projects.id, project_id)).limit(1);
  return row;
}

async function seed_user_project(label: string): Promise<string> {
  const email = `${label}@canyonos.test`;
  await create_test_user(email);
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  const [project] = await db
    .insert(projects)
    .values({ created_by: user!.id, name: label })
    .returning();
  return project!.id;
}

const save_project = (project_id: string | null, project_name: string | null = null) =>
  save_controller_project({ project_id, project_name }, REDIS_PORT);

const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => error
  );

describe('canyonos bootstrap', () => {
  // The suite points the Redis client at a closed port, so boot took the unreachable path.
  test('no user exists after startup', async () => {
    expect(await count_users()).toBe(0);

    const status = await api.auth.status.get();
    expect(status.data).toEqual({ has_users: false });
  });

  test('an unusable identity creates no project and no user', async () => {
    const before = await count_projects();

    for (const identity of ['0', '', '   ', 'not-a-uuid', null]) {
      expect(await rejection(save_project(identity))).toMatchObject({
        status: 422,
        code: 'canyonos.identity_unusable',
      });
    }
    await bootstrap_canyonos();

    expect(await count_projects()).toBe(before);
    expect(await count_users()).toBe(0);
  });

  test('the controller project is registered with no creator', async () => {
    const project_id = '11111111-1111-4111-8111-111111111111';
    expect(await save_project(project_id)).toEqual({ project_id, name: 'project_1' });

    const project = await read_project(project_id);
    expect(project?.redis_port).toBe(REDIS_PORT);
    expect(project?.created_by).toBeNull();
    expect(await count_users()).toBe(0);
  });

  test('the controller project takes the published project name, falling back when empty', async () => {
    const named_id = '55555555-5555-4555-8555-555555555555';
    expect((await save_project(named_id, 'portfolio_agent')).name).toBe('portfolio_agent');
    expect((await read_project(named_id))?.name).toBe('portfolio_agent');

    const empty_id = '66666666-6666-4666-8666-666666666666';
    await save_project(empty_id, '');
    expect((await read_project(empty_id))?.name).toBe('project_1');
  });

  test('a rerun with the same id writes no rows', async () => {
    const project_id = '22222222-2222-4222-8222-222222222222';
    await save_project(project_id);
    const before = await count_projects();

    await save_project(project_id);

    expect(await count_projects()).toBe(before);
    expect(await count_users()).toBe(0);
  });
});

describe('POST /v1/traces', () => {
  test('accepts an empty OTLP export unauthenticated', async () => {
    const response = await fetch(`${config.app.apiUrl}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-protobuf' },
      body: new Uint8Array(),
    });

    expect(response.status).toBe(200);
  });
});

describe('canyonos reads', () => {
  test('a registered user lists and reads the controller project and its requests', async () => {
    const project_id = '33333333-3333-4333-8333-333333333333';
    await save_project(project_id);
    await write_project_span(project_id, {
      span_id: 'canyonos-user-span',
      trace_id: 'canyonos-user-trace',
      start_time_unix_nano: NOW_NANOS - MINUTE_NANOS,
      end_time_unix_nano: NOW_NANOS,
    });
    const token = await authenticate('owner@canyonos.test');
    expect(await count_users()).toBe(1);
    const headers = bearer(token);

    const listed = await api.projects.get({ $headers: headers });
    expect(listed.error).toBeNull();
    expect(listed.data!.map((project) => project.id)).toContain(project_id);

    const detail = await api.projects[project_id]!.get({ $headers: headers });
    expect(detail.error).toBeNull();
    expect(detail.data?.name).toBe('project_1');

    const requests = await api.projects[project_id]!.requests.get({
      $headers: headers,
      $query: {
        from: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        to: new Date().toISOString(),
        limit: 20,
        offset: 0,
      },
    });
    expect(requests.error).toBeNull();
    expect(requests.data?.items.map((item) => item.session_id)).toEqual(['canyonos-user-trace']);
  });

  test('an existing project only takes the port: name, creator, timestamps stay', async () => {
    const project_id = await seed_user_project('kept-owner');
    const before = await read_project(project_id);

    expect(await save_project(project_id, 'renamed')).toEqual({ project_id, name: 'kept-owner' });

    expect(await read_project(project_id)).toEqual({ ...before!, redis_port: REDIS_PORT });
  });
});
