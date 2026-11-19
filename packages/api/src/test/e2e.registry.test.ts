// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';

import { db } from '@api/db/client';
import { workflows } from '@api/db/schema';
import {
  forget_synced_workflows,
  sync_listed_workflows,
} from '@api/modules/registry/registry.service';
import { config } from '@core/env';

import { api, setupE2ETests } from './e2e.setup';
import {
  reset_controller,
  seed_running_workflow,
  seed_workflows,
  seed_workflows_raw,
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

  test('a controller identity whose workflows are not JSON runs no workflow: 404, not 500', async () => {
    const { workflow_id } = await create_test_workflow({ name: 'Junk Identity' });
    await seed_running_workflow(workflow_id, NO_PROMPTS);
    await seed_workflows_raw('{not json');

    const res = await api.workflows[workflow_id]!.prompts.get({ $headers: bearer(TEST_API_KEY) });

    expect(res.error?.status as number).toBe(404);
    expect(error_code(res)).toBe('registry.workflow_not_running');
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
    expect(error_code(res)).toBe('registry.controller_unreachable');
  });
});

describe('on Kubernetes the operator lists workflow groups, and the dashboard their workflows', () => {
  beforeEach(reset_controller);

  /** Runs `work` as a dashboard on Kubernetes whose operator lists `workflow_group_id`, its
   * Redis the one the suite seeds. */
  async function listing(workflow_group_id: string, work: () => Promise<void>): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'registry-'));
    const path = join(dir, 'projects.json');
    const redis = { host: config.canyonos.redisHost, port: config.canyonos.redisPort };
    writeFileSync(
      path,
      JSON.stringify({ projects: [{ project_id: workflow_group_id, name: 'hello', redis }] })
    );
    const docker = config.canyonos.workflowsFile;
    config.canyonos.workflowsFile = path;
    forget_synced_workflows();
    try {
      await work();
    } finally {
      config.canyonos.workflowsFile = docker;
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("each workflow of a listed group is stored by its own id, and its routes reach the group's Redis", async () => {
    const workflow_group_id = crypto.randomUUID();
    const workflow_id = await run_controller('helloworld');
    // What an older dashboard stored for the listed group, as if it were a workflow.
    await db.insert(workflows).values({ id: workflow_group_id, name: 'hello' });

    await listing(workflow_group_id, async () => {
      await sync_listed_workflows();

      const stored = await read_workflow(workflow_id);
      expect(stored?.name).toBe('helloworld');
      expect(stored?.workflow_group_id).toBe(workflow_group_id);
      // No Redis login is copied into the database: it stays in the operator's list.
      expect(stored?.redis_password).toBeNull();
      expect(await read_workflow(workflow_group_id)).toBeUndefined();

      const read = await api.workflows[workflow_id]!.prompts.get({
        $headers: bearer(TEST_API_KEY),
      });
      expect(read.error).toBeNull();
      expect(read.data).toEqual([]);
      const by_group = await api.workflows[workflow_group_id]!.prompts.get({
        $headers: bearer(TEST_API_KEY),
      });
      expect(by_group.error?.status as number).toBe(404);

      // A workflow added to the running group shows up at the next sync.
      const added_id = crypto.randomUUID();
      await seed_workflows({ [workflow_id]: 'helloworld', [added_id]: 'portfolio' });
      await sync_listed_workflows();
      expect((await read_workflow(added_id))?.workflow_group_id).toBe(workflow_group_id);
    });
  });

  test('a workflow whose group the operator does not list is not running in the cluster', async () => {
    const workflow_id = await run_controller('elsewhere');
    await db
      .insert(workflows)
      .values({ id: workflow_id, name: 'elsewhere', workflow_group_id: crypto.randomUUID() });

    await listing(crypto.randomUUID(), async () => {
      const read = await api.workflows[workflow_id]!.prompts.get({
        $headers: bearer(TEST_API_KEY),
      });
      expect(read.error?.status as number).toBe(404);
      expect(error_code(read)).toBe('registry.workflow_not_running');
    });
  });
});
