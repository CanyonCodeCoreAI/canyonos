// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';

import { db } from '@api/db/client';
import {
  RESOURCE_WORKFLOW_ATTRIBUTE,
  WORKFLOW_ID_ATTRIBUTE,
} from '@api/modules/telemetry/telemetry.contract';
import {
  otelLogs,
  otelMetricRollups,
  otelMetrics,
  otelSpans,
} from '@api/modules/telemetry/telemetry.schema';

import { api, group_workflow, setupE2ETests } from './e2e.setup';
import { reset_controller, seed_running_workflow } from './redis-test.utils';
import {
  encode_metrics_export,
  metrics_export,
  post_otlp,
  write_workflow_span,
} from './telemetry-test.utils';
import { bearer, create_test_workflow, TEST_API_KEY } from './workflow-test.utils';

setupE2ETests();

const key_headers = bearer(TEST_API_KEY);

describe('workflow list and detail', () => {
  test('lists and reads a workflow', async () => {
    const token = TEST_API_KEY;
    const headers = bearer(token);
    const { workflow_id } = await create_test_workflow({ name: 'Demo Flow' });

    const list = await api.v1.workflows.get({ $headers: headers });
    expect(list.error).toBeNull();
    expect(list.data?.find(({ id }) => id === workflow_id)).toMatchObject({ name: 'Demo Flow' });

    const detail = await api.v1.workflows[workflow_id]!.get({ $headers: headers });
    expect(detail.error).toBeNull();
    expect(detail.data).toMatchObject({
      id: workflow_id,
      name: 'Demo Flow',
      workflow_group_id: workflow_id,
    });
  });

  test('lets the API key list and read a workflow', async () => {
    const headers = bearer(TEST_API_KEY);
    const { workflow_id } = await create_test_workflow({ name: 'Shared' });

    const list = await api.v1.workflows.get({ $headers: headers });
    expect(list.data?.some(({ id }) => id === workflow_id)).toBe(true);
    const detail = await api.v1.workflows[workflow_id]!.get({ $headers: headers });
    expect(detail.data?.id).toBe(workflow_id);
  });

  test('returns 404 workflows.not_found for an unknown workflow', async () => {
    const token = TEST_API_KEY;
    const unknown = '00000000-0000-4000-8000-000000000000';

    const res = await api.v1.workflows[unknown]!.get({ $headers: bearer(token) });
    expect(res.error?.status as number).toBe(404);
    expect((res.error?.value as { error?: string })?.error).toBe('workflows.not_found');
  });

  test('shows a caller with no key no workflow of a workflow group that has one, and refuses a key that opens none', async () => {
    const { workflow_id } = await create_test_workflow({ name: 'Keyed' });

    const listed = await api.v1.workflows.get();
    expect(listed.error).toBeNull();
    expect(listed.data!.map(({ id }) => id)).not.toContain(workflow_id);
    expect((await api.v1.workflows[workflow_id]!.get()).error?.status as number).toBe(404);
    expect(
      (await api.v1.workflows.get({ $headers: bearer('opens-nothing') })).error?.status as number
    ).toBe(401);
  });
});

async function write_telemetry(workflow_id: string): Promise<void> {
  await write_workflow_span(workflow_id, { span_id: `span-${workflow_id}` });
  const resource_attributes = { [RESOURCE_WORKFLOW_ATTRIBUTE]: workflow_id };
  const now_unix_nano = BigInt(Date.now()) * 1_000_000n;
  const response = await post_otlp(
    workflow_id,
    'metrics',
    encode_metrics_export(
      metrics_export(
        workflow_id,
        'canyonos-test',
        'canyonos.test.metrics',
        [
          {
            name: 'canyonos.test.gauge',
            gauge: { dataPoints: [{ timeUnixNano: String(now_unix_nano), asDouble: 1 }] },
          },
        ],
        resource_attributes
      )
    )
  );
  expect(response.status).toBe(200);
  await db.insert(otelLogs).values({
    resource_attributes,
    time_unix_nano: now_unix_nano,
    observed_time_unix_nano: now_unix_nano,
    body: 'hi',
  });
}

/** How many spans, metrics, metric rollups and logs name workflow_id. */
async function telemetry_counts(workflow_id: string): Promise<number[]> {
  const count = sql<number>`count(*)::int`;
  const [spans] = await db
    .select({ count })
    .from(otelSpans)
    .where(sql`${otelSpans.attributes} ->> ${WORKFLOW_ID_ATTRIBUTE} = ${workflow_id}`);
  const [metrics] = await db
    .select({ count })
    .from(otelMetrics)
    .where(
      sql`${otelMetrics.resource_attributes} ->> ${RESOURCE_WORKFLOW_ATTRIBUTE} = ${workflow_id}`
    );
  const [rollups] = await db
    .select({ count })
    .from(otelMetricRollups)
    .where(
      sql`${otelMetricRollups.resource_attributes} ->> ${RESOURCE_WORKFLOW_ATTRIBUTE} = ${workflow_id}`
    );
  const [logs] = await db
    .select({ count })
    .from(otelLogs)
    .where(
      sql`${otelLogs.resource_attributes} ->> ${RESOURCE_WORKFLOW_ATTRIBUTE} = ${workflow_id}`
    );
  return [spans!.count, metrics!.count, rollups!.count, logs!.count];
}

describe('DELETE /v1/workflow-groups/:workflow_group_id/workflows/:workflow_id/history', () => {
  beforeEach(reset_controller);

  test('deletes a stopped workflow and its telemetry, and leaves other workflows alone', async () => {
    const token = TEST_API_KEY;
    const headers = bearer(token);
    const { workflow_id } = await create_test_workflow({ name: 'Stopped' });
    const { workflow_id: other_id } = await create_test_workflow({ name: 'Other' });
    await write_telemetry(workflow_id);
    await write_telemetry(other_id);

    const res = await group_workflow(workflow_id).history.delete(undefined, {
      headers: key_headers,
    });
    expect(res.error).toBeNull();
    expect(res.data).toEqual({ workflow_id });

    const detail = await api.v1.workflows[workflow_id]!.get({ $headers: headers });
    expect(detail.error?.status as number).toBe(404);
    expect(await telemetry_counts(workflow_id)).toEqual([0, 0, 0, 0]);
    expect(await telemetry_counts(other_id)).toEqual([1, 1, 1, 1]);
  });

  test('refuses a running workflow with 409 workflows.running and keeps it', async () => {
    const token = TEST_API_KEY;
    const headers = bearer(token);
    const { workflow_id } = await create_test_workflow({ name: 'Running' });
    await seed_running_workflow(workflow_id, { prompts: {} });

    const res = await group_workflow(workflow_id).history.delete(undefined, {
      headers: key_headers,
    });
    expect(res.error?.status as number).toBe(409);
    expect((res.error?.value as { error?: string })?.error).toBe('workflows.running');

    const detail = await api.v1.workflows[workflow_id]!.get({ $headers: headers });
    expect(detail.data?.id).toBe(workflow_id);
  });

  test('refuses a workflow under a workflow group it is not in with 404 workflows.not_found and keeps it', async () => {
    const { workflow_id } = await create_test_workflow({ name: 'Own Group' });
    const { workflow_id: other_group_id } = await create_test_workflow({ name: 'Other Group' });

    const res = await group_workflow(workflow_id, other_group_id).history.delete(undefined, {
      headers: key_headers,
    });
    expect(res.error?.status as number).toBe(404);
    expect((res.error?.value as { error?: string })?.error).toBe('workflows.not_found');

    const detail = await api.v1.workflows[workflow_id]!.get({ $headers: key_headers });
    expect(detail.data?.id).toBe(workflow_id);
  });
});
