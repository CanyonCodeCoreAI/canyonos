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

import { hashApiKey } from './api-key-test.utils';
import { setupE2ETests } from './e2e.setup';
import { free_port, spawn_api } from './process-test.utils';
import { reset_controller, seed_controller_identity } from './redis-test.utils';
import { write_workflow_span } from './telemetry-test.utils';
import { createApi } from './test.utils';
import { bearer, create_test_workflow_group, TEST_API_KEY } from './workflow-test.utils';
import type { SpawnedApi } from './process-test.utils';

// What an API does with the Global Controller it finds as it starts, each started here as the
// image starts one and asked over HTTP once ready: on Docker it registers the controller on the
// configured Redis (self-host, where no `canyonos deploy` registers it) and its workflow group
// with the key hash that controller published, and on Kubernetes it stores the workflows of
// each workflow group the operator lists.

setupE2ETests();

const NOW_NANOS = BigInt(Date.now()) * 1_000_000n;
const MINUTE_NANOS = 60_000_000_000n;
const WRONG_KEY = 'not-the-controllers-key';
const NO_KEY = '';

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

  test("registers the controller's workflows with that Redis and their published names, and its workflow group with the key hash it published, which alone reads them and their requests", async () => {
    // No deploy made a row here: the controller's published key hash is the workflow group's.
    const workflow_group_id = crypto.randomUUID();
    const first = crypto.randomUUID();
    const named = crypto.randomUUID();
    await seed_controller_identity(
      workflow_group_id,
      { [first]: 'workflow_1', [named]: 'portfolio_agent' },
      hashApiKey(TEST_API_KEY)
    );

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

      expect((await client.v1.auth.status.get()).data).toEqual({ api_key_required: true });
      expect((await client.v1.auth.check.get({ $headers: headers })).data).toEqual({ ok: true });
      const listed = await client.v1.workflows.get({ $headers: headers });
      expect(listed.error).toBeNull();
      expect(listed.data!.map(({ id }) => id)).toEqual(expect.arrayContaining([first, named]));
      const hidden = await client.v1.workflows.get();
      expect(hidden.data!.map(({ id }) => id)).not.toEqual(expect.arrayContaining([first]));
      const refused = await client.v1.workflows.get({ $headers: bearer(WRONG_KEY) });
      expect(refused.error).toMatchObject({ status: 401 });

      const detail = await client.v1.workflows[first]!.get({ $headers: headers });
      expect(detail.error).toBeNull();
      expect(detail.data?.name).toBe('workflow_1');

      const requests = await client.v1['workflow-groups'][workflow_group_id]!.workflows[
        first
      ]!.requests.get({
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

  test('a controller deployed with no key makes its workflow group open: its workflows list to anyone', async () => {
    const workflow_group_id = crypto.randomUUID();
    const workflow_id = crypto.randomUUID();
    await seed_controller_identity(workflow_group_id, { [workflow_id]: 'workflow_1' }, NO_KEY);

    await with_api({}, async ({ url }) => {
      const client = createApi(url);
      const listed = await client.v1.workflows.get();
      expect(listed.error).toBeNull();
      expect(listed.data!.map(({ id }) => id)).toContain(workflow_id);
      const scaling =
        await client.v1['workflow-groups'][workflow_group_id]!.workflows[
          workflow_id
        ]!.scaling.get();
      expect(scaling.error).toBeNull();
    });
  }, 40_000);

  test('a controller that has not published its key hash yet registers its workflows, which stay hidden until it does', async () => {
    const workflow_group_id = crypto.randomUUID();
    const workflow_id = crypto.randomUUID();
    await seed_controller_identity(workflow_group_id, { [workflow_id]: 'workflow_1' });

    await with_api({}, async ({ url }) => {
      expect(await read_workflow(workflow_id)).toMatchObject({ workflow_group_id });
      const listed = await createApi(url).v1.workflows.get();
      expect(listed.data!.map(({ id }) => id)).not.toContain(workflow_id);
    });
    await seed_controller_identity(
      workflow_group_id,
      { [workflow_id]: 'workflow_1' },
      hashApiKey(TEST_API_KEY)
    );
    await with_api({}, async ({ url }) => {
      const listed = await createApi(url).v1.workflows.get({ $headers: bearer(TEST_API_KEY) });
      expect(listed.data!.map(({ id }) => id)).toContain(workflow_id);
    });
  }, 60_000);

  test('a restart with the same controller writes no rows, and a key it changed holds', async () => {
    const workflow_group_id = crypto.randomUUID();
    const workflow_id = crypto.randomUUID();
    await seed_controller_identity(
      workflow_group_id,
      { [workflow_id]: 'workflow_1' },
      hashApiKey(TEST_API_KEY)
    );

    await with_api({}, async () => undefined);
    const before = await count_workflows();
    expect(await read_workflow(workflow_id)).toBeDefined();

    await with_api({}, async () => undefined);
    expect(await count_workflows()).toBe(before);

    // Deployed again with another key: the controller publishes the new hash.
    const changed = 'the-controllers-new-key';
    await seed_controller_identity(
      workflow_group_id,
      { [workflow_id]: 'workflow_1' },
      hashApiKey(changed)
    );
    await with_api({}, async ({ url }) => {
      const client = createApi(url);
      const old = await client.v1.workflows[workflow_id]!.get({ $headers: bearer(TEST_API_KEY) });
      expect(old.error).toMatchObject({ status: 404 });
      const listed = await client.v1.workflows.get({ $headers: bearer(changed) });
      expect(listed.data!.map(({ id }) => id)).toContain(workflow_id);
    });
    expect(await count_workflows()).toBe(before);
  }, 60_000);

  test('an identity with no usable workflow group id registers nothing, and the API is ready anyway', async () => {
    const workflow_id = crypto.randomUUID();
    const before = await count_workflows();

    for (const identity of ['0', '', '   ', 'not-a-uuid', null]) {
      await seed_controller_identity(identity, { [workflow_id]: 'workflow_1' });
      await with_api({}, async ({ url }) => {
        expect((await fetch(`${url}/v1/readyz`)).status).toBe(200);
      });
    }

    expect(await read_workflow(workflow_id)).toBeUndefined();
    expect(await count_workflows()).toBe(before);
  }, 60_000);

  test('a configured Redis that does not answer registers nothing, and the API is ready anyway', async () => {
    const workflow_id = crypto.randomUUID();
    // On the suite's Redis, which this API is not pointed at.
    await seed_controller_identity(crypto.randomUUID(), { [workflow_id]: 'workflow_1' }, NO_KEY);
    const before = await count_workflows();

    await with_api({ CANYONOS_REDIS_PORT: String(free_port()) }, async ({ url }) => {
      expect((await fetch(`${url}/v1/readyz`)).status).toBe(200);
    });

    expect(await read_workflow(workflow_id)).toBeUndefined();
    expect(await count_workflows()).toBe(before);
  }, 40_000);
});

describe('an API started on Kubernetes', () => {
  beforeEach(reset_controller);
  afterAll(reset_controller);

  test('stores the workflows of each listed workflow group by their own ids; a group whose Redis cannot be read stores nothing, never itself, and the API is ready anyway', async () => {
    // The row the API restores from the CanyonProject as it starts, with its key.
    const listed_id = await create_test_workflow_group();
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

        const prompts = await createApi(url).v1['workflow-groups'][listed_id]!.workflows[
          workflow_id
        ]!.prompts.get({
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
