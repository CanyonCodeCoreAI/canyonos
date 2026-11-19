// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test';

import { db } from '@api/db/client';
import { workflows } from '@api/db/schema';

import { api, setupE2ETests } from './e2e.setup';
import { seed_active_agents, seed_running_workflow } from './redis-test.utils';
import { bearer } from './workflow-test.utils';
import type { ScalingPolicy } from '../modules/scaling/scaling.types';

setupE2ETests();

const RANGE_TO = new Date();

const RANGE = {
  from: new Date(RANGE_TO.getTime() - 365 * 86_400_000).toISOString(),
  to: RANGE_TO.toISOString(),
};

const STALE_BEARER = bearer('a key from before the API ran open');

const POLICY: ScalingPolicy = {
  min_replicas: 1,
  max_replicas: 3,
  metric: 'requests_per_minute_per_replica',
  scale_up_above: 10,
  scale_down_below: 1,
};

async function open_workflow(name: string): Promise<string> {
  const [workflow] = await db.insert(workflows).values({ name }).returning({ id: workflows.id });
  await seed_running_workflow(workflow!.id, { prompts: {} });
  await seed_active_agents(JSON.stringify(['app.Alpha']));
  return workflow!.id;
}

describe('no CANYONOS_API_KEY_HASH', () => {
  test('/auth/status reports that no key is needed', async () => {
    const status = await api.auth.status.get();

    expect(status.data).toEqual({ api_key_required: false });
  });

  test('/auth/check answers ok with no key', async () => {
    const check = await api.auth.check.get();

    expect(check.data).toEqual({ ok: true });
  });

  test('a caller with no key lists workflows and changes scaling', async () => {
    const workflow_id = await open_workflow('Keyless Writes');

    const listed = await api.workflows.get();
    expect(listed.error).toBeNull();
    expect(listed.data!.map(({ id }) => id)).toContain(workflow_id);

    const saved = await api.workflows[workflow_id]!.scaling.put(POLICY);
    expect(saved.error).toBeNull();
  });

  // A key left in a browser from before the API ran open must not turn into a 401.
  test('a stale bearer is ignored', async () => {
    const workflow_id = await open_workflow('Stale Bearer');

    const listed = await api.workflows.get({ $headers: STALE_BEARER });
    expect(listed.error).toBeNull();
    expect(listed.data!.map(({ id }) => id)).toContain(workflow_id);

    const saved = await api.workflows[workflow_id]!.scaling.put(POLICY, {
      headers: STALE_BEARER,
    });
    expect(saved.error).toBeNull();
  });

  // The check is wired per plugin (workflows / requests / metrics / monitoring / prompts / scaling),
  // so reaching every sub-resource proves each composed plugin serves a caller with no headers.
  test('a caller with no headers lists the workflows and reaches every sub-resource', async () => {
    const workflow_id = await open_workflow('Open Workflow');

    const listed = await api.workflows.get();
    expect(listed.error).toBeNull();
    expect(listed.data!.map(({ id }) => id)).toContain(workflow_id);

    const responses = await Promise.all([
      api.workflows[workflow_id]!.get(),
      api.workflows[workflow_id]!.stats.get(),
      api.workflows[workflow_id]!.requests.get({ $query: { ...RANGE, limit: 20, offset: 0 } }),
      api.workflows[workflow_id]!.metrics.kpis.get({ $query: RANGE }),
      api.workflows[workflow_id]!.monitoring.series.get({ $query: RANGE }),
      api.workflows[workflow_id]!.monitoring.logs.get({
        $query: { ...RANGE, limit: 200, errors_only: false },
      }),
      api.workflows[workflow_id]!.monitoring.traces.get({ $query: { ...RANGE, limit: 200 } }),
      api.workflows[workflow_id]!.monitoring.resources.get({ $query: RANGE }),
      api.workflows[workflow_id]!.monitoring.replicas.get(),
      api.workflows[workflow_id]!.monitoring.endpoint.get(),
      api.workflows[workflow_id]!.prompts.get(),
      api.workflows[workflow_id]!.scaling.get(),
    ]);

    for (const res of responses) {
      expect(res.error).toBeNull();
    }
  });

  test('a workflow id that does not exist is 404 workflows.not_found', async () => {
    const unknown = '00000000-0000-4000-8000-000000000000';

    const res = await api.workflows[unknown]!.stats.get();

    expect(res.error?.status as number).toBe(404);
    expect((res.error?.value as { error?: string })?.error).toBe('workflows.not_found');
  });
});
