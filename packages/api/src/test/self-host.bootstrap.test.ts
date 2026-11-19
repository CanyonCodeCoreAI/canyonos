// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';

import { db } from '@api/db/client';
import { workflows } from '@api/db/schema';
import {
  bootstrap_canyonos,
  save_controller_workflows,
} from '@api/modules/canyonos/canyonos.bootstrap';
import { canyonos_repo } from '@api/modules/canyonos/canyonos.repo';
import { sync_registered_workflows } from '@api/modules/canyonos/canyonos.sync';
import { config } from '@core/env';

import { api, setupE2ETests } from './e2e.setup';
import { write_workflow_span } from './telemetry-test.utils';
import { bearer, TEST_API_KEY } from './workflow-test.utils';

setupE2ETests();

const REDIS_HOST = 'canyonos-billing-redis-localhost';
const REDIS_PORT = 6380;
const REDIS_PASSWORD = 's3cret';
const NOW_NANOS = BigInt(Date.now()) * 1_000_000n;
const MINUTE_NANOS = 60_000_000_000n;

const count_workflows = async (): Promise<number> =>
  (await db.select({ id: workflows.id }).from(workflows)).length;

async function read_workflow(workflow_id: string) {
  const [row] = await db.select().from(workflows).where(eq(workflows.id, workflow_id)).limit(1);
  return row;
}

async function seed_workflow(name: string): Promise<string> {
  const [workflow] = await db.insert(workflows).values({ name }).returning();
  return workflow!.id;
}

const WORKFLOW_GROUP_ID = '44444444-4444-4444-8444-444444444444';

const save_group = (workflow_group_id: string | null, workflows: Record<string, string> = {}) =>
  save_controller_workflows(
    { workflow_group_id, workflows },
    REDIS_HOST,
    REDIS_PORT,
    REDIS_PASSWORD
  );

const save_workflow = async (workflow_id: string, name = 'workflow_1') =>
  (await save_group(WORKFLOW_GROUP_ID, { [workflow_id]: name }))[0]!;

const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => error
  );

describe('canyonos bootstrap', () => {
  // The suite points the Redis client at a closed port, so boot took the unreachable path.
  test('an unusable identity creates no workflow', async () => {
    const before = await count_workflows();

    for (const identity of ['0', '', '   ', 'not-a-uuid', null]) {
      expect(await rejection(save_group(identity))).toMatchObject({
        status: 422,
        code: 'canyonos.identity_unusable',
      });
    }
    await bootstrap_canyonos();

    expect(await count_workflows()).toBe(before);
  });

  test('the controller workflow is registered with its Redis port', async () => {
    const workflow_id = '11111111-1111-4111-8111-111111111111';
    expect(await save_workflow(workflow_id)).toEqual({ workflow_id, name: 'workflow_1' });

    const workflow = await read_workflow(workflow_id);
    expect(workflow?.redis_port).toBe(REDIS_PORT);
  });

  test('the controller workflow takes the published workflow name', async () => {
    const named_id = '55555555-5555-4555-8555-555555555555';
    expect((await save_workflow(named_id, 'portfolio_agent')).name).toBe('portfolio_agent');
    expect((await read_workflow(named_id))?.name).toBe('portfolio_agent');
  });

  test('a rerun with the same id writes no rows', async () => {
    const workflow_id = '22222222-2222-4222-8222-222222222222';
    await save_workflow(workflow_id);
    const before = await count_workflows();

    await save_workflow(workflow_id);

    expect(await count_workflows()).toBe(before);
  });

  // e2e.canyonos-workflows.test.ts stores a listed workflow group's workflows from a real Redis.
  test('a listed workflow group whose Redis cannot be read stores nothing, and never itself as a workflow', async () => {
    const workflow_group_id = '77777777-7777-4777-8777-777777777777';
    const dir = mkdtempSync(join(tmpdir(), 'registry-'));
    const path = join(dir, 'projects.json');
    const entry = {
      project_id: workflow_group_id,
      name: 'helloworld',
      redis: { host: '127.0.0.1', port: 1, password: 'x' },
    };
    writeFileSync(path, JSON.stringify({ projects: [entry] }));
    try {
      const before = await count_workflows();
      await sync_registered_workflows(path);
      await sync_registered_workflows(path);

      expect(await read_workflow(workflow_group_id)).toBeUndefined();
      expect(await count_workflows()).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
  test('the API key lists and reads the controller workflow and its requests', async () => {
    const workflow_id = '33333333-3333-4333-8333-333333333333';
    await save_workflow(workflow_id);
    await write_workflow_span(workflow_id, {
      span_id: 'canyonos-user-span',
      trace_id: 'canyonos-user-trace',
      start_time_unix_nano: NOW_NANOS - MINUTE_NANOS,
      end_time_unix_nano: NOW_NANOS,
    });
    const token = TEST_API_KEY;
    const headers = bearer(token);

    const listed = await api.workflows.get({ $headers: headers });
    expect(listed.error).toBeNull();
    expect(listed.data!.map((workflow) => workflow.id)).toContain(workflow_id);

    const detail = await api.workflows[workflow_id]!.get({ $headers: headers });
    expect(detail.error).toBeNull();
    expect(detail.data?.name).toBe('workflow_1');

    const requests = await api.workflows[workflow_id]!.requests.get({
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

  test('an existing workflow only takes the Redis and its password, encrypted: name and timestamps stay', async () => {
    const workflow_id = await seed_workflow('kept-owner');
    const before = await read_workflow(workflow_id);

    expect(await save_workflow(workflow_id, 'renamed')).toEqual({
      workflow_id,
      name: 'kept-owner',
    });

    expect(await read_workflow(workflow_id)).toEqual({
      ...before!,
      redis_host: REDIS_HOST,
      redis_port: REDIS_PORT,
      redis_password: expect.not.stringContaining(REDIS_PASSWORD),
    });
    expect((await canyonos_repo.find_redis(workflow_id))?.redis_password).toBe(REDIS_PASSWORD);
  });
});
