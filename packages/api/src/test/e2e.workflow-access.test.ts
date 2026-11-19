// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test';

import { api, setupE2ETests } from './e2e.setup';
import { seed_running_workflow } from './redis-test.utils';
import { bearer, create_test_workflow, TEST_API_KEY } from './workflow-test.utils';

setupE2ETests();

const RANGE_TO = new Date();

const RANGE = {
  from: new Date(RANGE_TO.getTime() - 365 * 86_400_000).toISOString(),
  to: RANGE_TO.toISOString(),
};

async function create_workflow(): Promise<string> {
  const { workflow_id } = await create_test_workflow({ name: 'Access Workflow' });
  return workflow_id;
}

describe('workflow access across the /workflows tree', () => {
  test('the API key reaches the workflow', async () => {
    const token = TEST_API_KEY;
    const workflow_id = await create_workflow();

    const detail = await api.workflows[workflow_id]!.get({ $headers: bearer(token) });
    expect(detail.error).toBeNull();
    expect(detail.data?.id).toBe(workflow_id);
  });

  // The resolver is wired per plugin (workflows / requests / metrics / monitoring / prompts / scaling), so
  // reaching every sub-resource proves the new rule fires in each composed plugin.
  test('the API key reaches every workflow sub-resource', async () => {
    const workflow_id = await create_workflow();
    await seed_running_workflow(workflow_id, { prompts: {} });

    const read = { $headers: bearer(TEST_API_KEY) };

    const responses = await Promise.all([
      api.workflows[workflow_id]!.get(read),
      api.workflows[workflow_id]!.stats.get(read),
      api.workflows[workflow_id]!.requests.get({
        ...read,
        $query: { ...RANGE, limit: 20, offset: 0 },
      }),
      api.workflows[workflow_id]!.metrics.kpis.get({ ...read, $query: RANGE }),
      api.workflows[workflow_id]!.monitoring.series.get({ ...read, $query: RANGE }),
      api.workflows[workflow_id]!.monitoring.logs.get({
        ...read,
        $query: { ...RANGE, limit: 200, errors_only: false },
      }),
      api.workflows[workflow_id]!.monitoring.traces.get({
        ...read,
        $query: { ...RANGE, limit: 200 },
      }),
      api.workflows[workflow_id]!.monitoring.resources.get({
        ...read,
        $query: RANGE,
      }),
      api.workflows[workflow_id]!.monitoring.replicas.get(read),
      api.workflows[workflow_id]!.monitoring.endpoint.get(read),
      api.workflows[workflow_id]!.prompts.get(read),
      api.workflows[workflow_id]!.scaling.get(read),
    ]);

    for (const res of responses) {
      expect(res.error).toBeNull();
    }
    expect(await api.workflows.get(read)).toMatchObject({ error: null });
    expect((await api.workflows.get(read)).data!.map(({ id }) => id)).toContain(workflow_id);
  });

  test('a workflow id that does not exist is 404 workflows.not_found for any caller', async () => {
    const token = TEST_API_KEY;
    const unknown = '00000000-0000-4000-8000-000000000000';

    const res = await api.workflows[unknown]!.stats.get({ $headers: bearer(token) });

    expect(res.error?.status as number).toBe(404);
    expect((res.error?.value as { error?: string })?.error).toBe('workflows.not_found');
  });

  test('a caller with no API key is rejected before the workflow is resolved', async () => {
    const workflow_id = await create_workflow();

    expect((await api.workflows[workflow_id]!.get()).error?.status as number).toBe(401);
    expect((await api.workflows[workflow_id]!.prompts.get()).error?.status as number).toBe(401);
    expect((await api.workflows[workflow_id]!.scaling.get()).error?.status as number).toBe(401);
    expect((await api.workflows.get()).error?.status as number).toBe(401);
  });
});
