// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';

import { db } from '@api/db/client';
import { workflows } from '@api/db/schema';
import { config } from '@core/env';

import { setupE2ETests } from './e2e.setup';
import { free_port, spawn_api } from './process-test.utils';
import { reset_controller, seed_controller_identity } from './redis-test.utils';
import { write_workflow_span } from './telemetry-test.utils';
import { createApi } from './test.utils';
import { bearer, TEST_API_KEY } from './workflow-test.utils';
import type { SpawnedApi } from './process-test.utils';

// What an API does with the Global Controller it finds as it starts, each started here as the
// image starts one and asked over HTTP once ready: on Docker it registers the controller on the
// configured Redis (self-host, where no `canyonos deploy` registers it), and on Kubernetes it
// stores the workflows of each workflow group the operator lists.

setupE2ETests();

const NOW_NANOS = BigInt(Date.now()) * 1_000_000n;
const MINUTE_NANOS = 60_000_000_000n;

const count_workflows = async (): Promise<number> =>
  (await db.select({ id: workflows.id }).from(workflows)).length;

async function read_workflow(workflow_id: string) {
  const [row] = await db.select().from(workflows).where(eq(workflows.id, workflow_id)).limit(1);
  return row;
}

/** Runs `check` against an API started with `env`, then stops it. */
async function with_api(
  env: Record<string, string>,
  check: (api: SpawnedApi) => Promise<void>
): Promise<void> {
  const api = await spawn_api(env);
  try {
    await check(api);
  } finally {
    await api.stop();
  }
}

describe('an API started beside a Global Controller on the configured Redis', () => {
  beforeEach(reset_controller);
  afterAll(reset_controller);

  test("registers the controller's workflows with that Redis and their published names, and the API key reads them and their requests", async () => {
    const workflow_group_id = crypto.randomUUID();
    const first = crypto.randomUUID();
    const named = crypto.randomUUID();
    await seed_controller_identity(workflow_group_id, {
      [first]: 'workflow_1',
      [named]: 'portfolio_agent',
    });

    await with_api({}, async ({ url }) => {
      for (const [workflow_id, name] of [
        [first, 'workflow_1'],
        [named, 'portfolio_agent'],
      ] as const) {
        expect(await read_workflow(workflow_id)).toMatchObject({
          name,
          workflow_group_id,
          redis_host: config.canyonos.redisHost,
          redis_port: config.canyonos.redisPort,
        });
      }

      await write_workflow_span(first, {
        span_id: 'canyonos-user-span',
        trace_id: 'canyonos-user-trace',
        start_time_unix_nano: NOW_NANOS - MINUTE_NANOS,
        end_time_unix_nano: NOW_NANOS,
      });
      const client = createApi(url);
      const headers = bearer(TEST_API_KEY);

      const listed = await client.workflows.get({ $headers: headers });
      expect(listed.error).toBeNull();
      expect(listed.data!.map(({ id }) => id)).toEqual(expect.arrayContaining([first, named]));

      const detail = await client.workflows[first]!.get({ $headers: headers });
      expect(detail.error).toBeNull();
      expect(detail.data?.name).toBe('workflow_1');

      const requests = await client.workflows[first]!.requests.get({
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
  }, 40_000);

  test('a restart with the same controller writes no rows', async () => {
    const workflow_id = crypto.randomUUID();
    await seed_controller_identity(crypto.randomUUID(), { [workflow_id]: 'workflow_1' });

    await with_api({}, async () => undefined);
    const before = await count_workflows();
    expect(await read_workflow(workflow_id)).toBeDefined();

    await with_api({}, async () => undefined);

    expect(await count_workflows()).toBe(before);
  }, 40_000);

  test('an identity with no usable workflow group id registers nothing, and the API is ready anyway', async () => {
    const workflow_id = crypto.randomUUID();
    const before = await count_workflows();

    for (const identity of ['0', '', '   ', 'not-a-uuid', null]) {
      await seed_controller_identity(identity, { [workflow_id]: 'workflow_1' });
      await with_api({}, async ({ url }) => {
        expect((await fetch(`${url}/readyz`)).status).toBe(200);
      });
    }

    expect(await read_workflow(workflow_id)).toBeUndefined();
    expect(await count_workflows()).toBe(before);
  }, 60_000);

  test('a configured Redis that does not answer registers nothing, and the API is ready anyway', async () => {
    const workflow_id = crypto.randomUUID();
    // On the suite's Redis, which this API is not pointed at.
    await seed_controller_identity(crypto.randomUUID(), { [workflow_id]: 'workflow_1' });
    const before = await count_workflows();

    await with_api({ CANYONOS_REDIS_PORT: String(free_port()) }, async ({ url }) => {
      expect((await fetch(`${url}/readyz`)).status).toBe(200);
    });

    expect(await read_workflow(workflow_id)).toBeUndefined();
    expect(await count_workflows()).toBe(before);
  }, 40_000);
});

describe('an API started on Kubernetes', () => {
  beforeEach(reset_controller);
  afterAll(reset_controller);

  test('stores the workflows of each listed workflow group by their own ids; a group whose Redis cannot be read stores nothing, never itself, and the API is ready anyway', async () => {
    const listed_id = crypto.randomUUID();
    const unread_id = crypto.randomUUID();
    const workflow_id = crypto.randomUUID();
    // What the listed group's Global Controller publishes in its Redis.
    await seed_controller_identity(listed_id, { [workflow_id]: 'helloworld' });
    const dir = mkdtempSync(join(tmpdir(), 'bootstrap-'));
    const path = join(dir, 'projects.json');
    writeFileSync(
      path,
      JSON.stringify({
        projects: [
          {
            project_id: listed_id,
            name: 'hello',
            redis: { host: config.canyonos.redisHost, port: config.canyonos.redisPort },
          },
          {
            project_id: unread_id,
            name: 'unread',
            redis: { host: '127.0.0.1', port: free_port(), password: 'x' },
          },
        ],
      })
    );
    try {
      await with_api({ CANYONOS_PROJECTS_FILE: path }, async ({ url }) => {
        expect(await read_workflow(workflow_id)).toMatchObject({
          name: 'helloworld',
          workflow_group_id: listed_id,
        });
        expect(await read_workflow(listed_id)).toBeUndefined();
        expect(await read_workflow(unread_id)).toBeUndefined();

        const prompts = await createApi(url).workflows[workflow_id]!.prompts.get({
          $headers: bearer(TEST_API_KEY),
        });
        expect(prompts.error).toBeNull();
        expect(prompts.data).toEqual([]);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40_000);
});
