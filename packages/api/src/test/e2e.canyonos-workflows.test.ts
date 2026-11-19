// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';

import { db } from '@api/db/client';
import { workflows } from '@api/db/schema';
import { config } from '@core/env';

import { api, setupE2ETests } from './e2e.setup';
import {
  reset_controller,
  seed_running_workflow,
  seed_workflows,
  TEST_WORKFLOW_GROUP_ID,
} from './redis-test.utils';
import { bearer, create_test_workflow, TEST_API_KEY } from './workflow-test.utils';

setupE2ETests();

const CLOSED_PORT = 1;
const CONTAINER_REDIS_HOST = 'canyonos-other-redis-localhost';
const NO_PROMPTS = { prompts: {} };

const error_code = (res: { error: { value?: unknown } | null }) =>
  (res.error?.value as { error?: string } | undefined)?.error;

async function read_workflow(workflow_id: string) {
  const [row] = await db.select().from(workflows).where(eq(workflows.id, workflow_id)).limit(1);
  return row;
}

async function run_controller(workflow_name: string): Promise<string> {
  const workflow_id = crypto.randomUUID();
  await seed_running_workflow(workflow_id, NO_PROMPTS, workflow_name);
  return workflow_id;
}

const register = (redis_port: number) =>
  api.canyonos.workflows.post({ redis_port, redis_password: '' });

describe('POST /canyonos/workflows', () => {
  beforeEach(reset_controller);

  test('registers each workflow of the running controller with the port it was read from', async () => {
    const workflow_id = await run_controller('helloworld');
    const other_id = crypto.randomUUID();
    await seed_workflows({ [workflow_id]: 'helloworld', [other_id]: 'portfolio' });

    const res = await register(config.canyonos.redisPort);

    expect(res.error).toBeNull();
    expect(res.data).toEqual({
      workflows: [
        { workflow_id, name: 'helloworld' },
        { workflow_id: other_id, name: 'portfolio' },
      ],
    });
    for (const id of [workflow_id, other_id]) {
      const workflow = await read_workflow(id);
      expect(workflow?.redis_port).toBe(config.canyonos.redisPort);
      expect(workflow?.workflow_group_id).toBe(TEST_WORKFLOW_GROUP_ID);
    }
  });

  test('an unreachable Redis is 502 and registers nothing', async () => {
    const workflow_id = await run_controller('unreached');

    const res = await register(CLOSED_PORT);

    expect(res.error?.status as number).toBe(502);
    expect(error_code(res)).toBe('canyonos.controller_unreachable');
    expect(await read_workflow(workflow_id)).toBeUndefined();
  });

  test('a Redis with no controller identity is 422', async () => {
    const res = await register(config.canyonos.redisPort);

    expect(res.error?.status as number).toBe(422);
    expect(error_code(res)).toBe('canyonos.identity_unusable');
  });

  test('an api on loopback reaches a container host on its own Redis host and stores the sent host', async () => {
    const workflow_id = await run_controller('in-container');

    const res = await api.canyonos.workflows.post({
      redis_host: CONTAINER_REDIS_HOST,
      redis_port: config.canyonos.redisPort,
      redis_password: '',
    });

    expect(res.error).toBeNull();
    expect(res.data).toEqual({ workflows: [{ workflow_id, name: 'in-container' }] });
    expect((await read_workflow(workflow_id))?.redis_host).toBe(CONTAINER_REDIS_HOST);
  });

  test('a host other than a CanyonOS Redis container is rejected before any connection', async () => {
    for (const redis_host of ['10.0.0.5', 'example.com', 'canyonos-a-redis-localhost.evil.com']) {
      const res = await api.canyonos.workflows.post({
        redis_host,
        redis_port: 6379,
        redis_password: '',
      });

      expect(res.error?.status as number).toBe(422);
      expect(error_code(res)).toBe('validation_error');
    }
  });

  test('a port outside 1..65535 is rejected before any connection', async () => {
    for (const redis_port of [0, 65536, 6379.5]) {
      const res = await register(redis_port);

      expect(res.error?.status as number).toBe(422);
      expect(error_code(res)).toBe('validation_error');
    }
  });

  test('registering again takes the new port and keeps the stored name', async () => {
    const workflow_id = await run_controller('first-name');
    await register(config.canyonos.redisPort);
    await db
      .update(workflows)
      .set({ redis_port: CLOSED_PORT })
      .where(eq(workflows.id, workflow_id));
    await seed_workflows({ [workflow_id]: 'second-name' });

    const res = await register(config.canyonos.redisPort);

    expect(res.data).toEqual({ workflows: [{ workflow_id, name: 'first-name' }] });
    const workflow = await read_workflow(workflow_id);
    expect(workflow?.name).toBe('first-name');
    expect(workflow?.redis_port).toBe(config.canyonos.redisPort);
  });
});

describe('Redis-backed routes use the workflow port', () => {
  beforeEach(reset_controller);

  test('a workflow without a port is served from the configured Redis', async () => {
    const token = TEST_API_KEY;
    const { workflow_id } = await create_test_workflow({ name: 'Default Port' });
    await seed_running_workflow(workflow_id, NO_PROMPTS);

    const res = await api.workflows[workflow_id]!.prompts.get({ $headers: bearer(token) });

    expect(res.error).toBeNull();
    expect(res.data).toEqual([]);
  });

  test('an api on loopback reads a workflow stored with a container host on its own Redis host', async () => {
    const token = TEST_API_KEY;
    const { workflow_id } = await create_test_workflow({ name: 'Container Host' });
    await seed_running_workflow(workflow_id, NO_PROMPTS);
    await db
      .update(workflows)
      .set({ redis_host: CONTAINER_REDIS_HOST, redis_port: config.canyonos.redisPort })
      .where(eq(workflows.id, workflow_id));

    const res = await api.workflows[workflow_id]!.prompts.get({ $headers: bearer(token) });

    expect(res.error).toBeNull();
    expect(res.data).toEqual([]);
  });

  test('a workflow registered on another port is read there, not from the configured Redis', async () => {
    const token = TEST_API_KEY;
    const { workflow_id } = await create_test_workflow({ name: 'Own Port' });
    await seed_running_workflow(workflow_id, NO_PROMPTS);
    await db
      .update(workflows)
      .set({ redis_port: CLOSED_PORT })
      .where(eq(workflows.id, workflow_id));

    const res = await api.workflows[workflow_id]!.prompts.get({ $headers: bearer(token) });

    expect(res.error?.status as number).toBe(502);
    expect(error_code(res)).toBe('canyonos.controller_unreachable');
  });
});
