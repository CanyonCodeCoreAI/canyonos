// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';

import { db } from '@api/db/client';
import { projects } from '@api/db/schema';
import { config } from '@core/env';

import { api, setupE2ETests } from './e2e.setup';
import { authenticate, bearer, create_test_project } from './project-test.utils';
import { reset_controller, seed_project_name, seed_running_project } from './redis-test.utils';

setupE2ETests();

const CLOSED_PORT = 1;
const NO_PROMPTS = { prompts: {} };

const error_code = (res: { error: { value?: unknown } | null }) =>
  (res.error?.value as { error?: string } | undefined)?.error;

async function read_project(project_id: string) {
  const [row] = await db.select().from(projects).where(eq(projects.id, project_id)).limit(1);
  return row;
}

async function run_controller(project_name: string): Promise<string> {
  const project_id = crypto.randomUUID();
  await seed_running_project(project_id, NO_PROMPTS);
  await seed_project_name(project_name);
  return project_id;
}

const register = (redis_port: number) => api.canyonos.projects.post({ redis_port });

describe('POST /canyonos/projects', () => {
  beforeEach(reset_controller);

  test('registers the running controller project with the port it was read from', async () => {
    const project_id = await run_controller('helloworld');

    const res = await register(config.canyonos.redisPort);

    expect(res.error).toBeNull();
    expect(res.data).toEqual({ project_id, name: 'helloworld' });
    expect((await read_project(project_id))?.redis_port).toBe(config.canyonos.redisPort);
  });

  test('an unreachable Redis is 502 and registers nothing', async () => {
    const project_id = await run_controller('unreached');

    const res = await register(CLOSED_PORT);

    expect(res.error?.status as number).toBe(502);
    expect(error_code(res)).toBe('canyonos.controller_unreachable');
    expect(await read_project(project_id)).toBeUndefined();
  });

  test('a Redis with no controller identity is 422', async () => {
    const res = await register(config.canyonos.redisPort);

    expect(res.error?.status as number).toBe(422);
    expect(error_code(res)).toBe('canyonos.identity_unusable');
  });

  test('a port outside 1..65535 is rejected before any connection', async () => {
    for (const redis_port of [0, 65536, 6379.5]) {
      const res = await register(redis_port);

      expect(res.error?.status as number).toBe(422);
      expect(error_code(res)).toBe('validation_error');
    }
  });

  test('registering again takes the new port and keeps the stored name', async () => {
    const project_id = await run_controller('first-name');
    await register(config.canyonos.redisPort);
    await db.update(projects).set({ redis_port: CLOSED_PORT }).where(eq(projects.id, project_id));
    await seed_project_name('second-name');

    const res = await register(config.canyonos.redisPort);

    expect(res.data).toEqual({ project_id, name: 'first-name' });
    const project = await read_project(project_id);
    expect(project?.name).toBe('first-name');
    expect(project?.redis_port).toBe(config.canyonos.redisPort);
  });
});

describe('Redis-backed routes use the project port', () => {
  beforeEach(reset_controller);

  test('a project without a port is served from the configured Redis', async () => {
    const token = await authenticate('canyonos-port-default@canyonos.test');
    const { project_id } = await create_test_project(token, { name: 'Default Port' });
    await seed_running_project(project_id, NO_PROMPTS);

    const res = await api.projects[project_id]!.prompts.get({ $headers: bearer(token) });

    expect(res.error).toBeNull();
    expect(res.data).toEqual([]);
  });

  test('a project registered on another port is read there, not from the configured Redis', async () => {
    const token = await authenticate('canyonos-port-own@canyonos.test');
    const { project_id } = await create_test_project(token, { name: 'Own Port' });
    await seed_running_project(project_id, NO_PROMPTS);
    await db.update(projects).set({ redis_port: CLOSED_PORT }).where(eq(projects.id, project_id));

    const res = await api.projects[project_id]!.prompts.get({ $headers: bearer(token) });

    expect(res.error?.status as number).toBe(502);
    expect(error_code(res)).toBe('canyonos.controller_unreachable');
  });
});
