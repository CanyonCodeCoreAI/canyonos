// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test';
import { eq, like, sql } from 'drizzle-orm';

import { db } from '@api/db/client';
import { seedMonitoringDemo } from '@api/db/seed-monitoring-demo';
import { seedDevTelemetry } from '@api/db/seed-telemetry';
import { RESOURCE_WORKFLOW_ATTRIBUTE } from '@api/modules/telemetry/telemetry.contract';
import { otelMetricRollups, otelSpans } from '@api/modules/telemetry/telemetry.schema';

import { api, setupE2ETests } from './e2e.setup';
import { bearer, create_test_workflow, TEST_API_KEY } from './workflow-test.utils';

setupE2ETests();

const range = () => {
  const to = new Date();
  return {
    from: new Date(to.getTime() - 7 * 86_400_000).toISOString(),
    to: to.toISOString(),
  };
};

async function rollup_totals(workflow_id: string) {
  const [totals] = await db
    .select({
      rows: sql<number>`count(*)::int`,
      readings: sql<number>`coalesce(sum(${otelMetricRollups.count}), 0)::int`,
    })
    .from(otelMetricRollups)
    .where(
      sql`${otelMetricRollups.resource_attributes} ->> ${RESOURCE_WORKFLOW_ATTRIBUTE} = ${workflow_id}`
    );
  return totals!;
}

describe('otel dev seed', () => {
  test('the seeded workflow reports its spans through the KPI endpoint', async () => {
    const token = TEST_API_KEY;
    const workflow_id = await seedDevTelemetry();

    const listed = await api.workflows.get({ $headers: bearer(token) });
    expect(listed.data!.map((workflow) => workflow.id)).toContain(workflow_id);

    const kpis = await api.workflows[workflow_id]!.metrics.kpis.get({
      $query: range(),
      $headers: bearer(token),
    });
    expect(kpis.error).toBeNull();
    const window = kpis.data!;
    expect(window.request_count).toBeGreaterThan(0);
    expect(window.block_count).toBeGreaterThan(0);
    expect(Number(window.total_cost)).toBeGreaterThan(0);
  });

  test('a rerun duplicates neither the workflow nor the telemetry counts', async () => {
    const token = TEST_API_KEY;
    const workflow_id = await seedDevTelemetry();

    const first_workflows = await api.workflows.get({ $headers: bearer(token) });
    const before = (
      await api.workflows[workflow_id]!.metrics.kpis.get({
        $query: range(),
        $headers: bearer(token),
      })
    ).data!;

    expect(await seedDevTelemetry()).toBe(workflow_id);

    const after_workflows = await api.workflows.get({ $headers: bearer(token) });
    expect(after_workflows.data).toHaveLength(first_workflows.data!.length);
    const after = (
      await api.workflows[workflow_id]!.metrics.kpis.get({
        $query: range(),
        $headers: bearer(token),
      })
    ).data!;
    expect(after.block_count).toBe(before.block_count);
    expect(after.request_count).toBe(before.request_count);
    expect(after.total_cost).toBe(before.total_cost);
  });

  test('the queries listing shows several seeded queries, one of them failed', async () => {
    const token = TEST_API_KEY;
    const workflow_id = await seedDevTelemetry();

    const listing = await api.workflows[workflow_id]!.requests.get({
      $headers: bearer(token),
      $query: { limit: 20, offset: 0, ...range() },
    });
    expect(listing.error).toBeNull();
    expect(listing.data!.total).toBeGreaterThan(1);
    expect(listing.data!.items.map((item) => item.status)).toContain('failed');
    expect(listing.data!.items.some((item) => item.token_count > 0)).toBe(true);
  });

  test('a seeded query carries its own input and output', async () => {
    const token = TEST_API_KEY;
    const workflow_id = await seedDevTelemetry();
    const listing = await api.workflows[workflow_id]!.requests.get({
      $headers: bearer(token),
      $query: { limit: 20, offset: 0, ...range() },
    });

    const traces = await Promise.all(
      listing.data!.items.map((item) =>
        api.workflows[workflow_id]!.requests[item.session_id]!.get({
          $query: range(),
          $headers: bearer(token),
        })
      )
    );
    expect(traces.some((trace) => typeof trace.data?.input === 'string')).toBe(true);
    expect(traces.some((trace) => typeof trace.data?.output === 'string')).toBe(true);
  });

  test('the window reports an unpriced block rather than a free one', async () => {
    const token = TEST_API_KEY;
    const workflow_id = await seedDevTelemetry();

    const window = (
      await api.workflows[workflow_id]!.metrics.kpis.get({
        $query: range(),
        $headers: bearer(token),
      })
    ).data!;
    expect(window.costed_block_count).toBeGreaterThan(0);
    expect(window.costed_block_count).toBeLessThan(window.block_count);
    expect(window.tokens).toBeGreaterThan(0);
  });

  test('the agent drawer reports an agent that answered under more than one id', async () => {
    const token = TEST_API_KEY;
    const workflow_id = await seedDevTelemetry();

    const blocks = await api.workflows[workflow_id]!.metrics.blocks.get({
      $headers: bearer(token),
      $query: { ...range() },
    });
    expect(blocks.error).toBeNull();

    const replica_counts = await Promise.all(
      [...new Set(blocks.data!.blocks.map((block) => block.agent_id))].map(async (agent_id) => {
        const drawer = await api.workflows[workflow_id]!.metrics.agents[agent_id]!.get({
          $query: range(),
          $headers: bearer(token),
        });
        expect(drawer.error).toBeNull();
        return drawer.data!.agent.replica_count;
      })
    );
    expect(replica_counts.some((count) => count > 1)).toBe(true);
  });

  test('the API key reads the seeded workflow and its spans', async () => {
    const workflow_id = await seedDevTelemetry();

    const workflows = await api.workflows.get({ $headers: bearer(TEST_API_KEY) });
    expect(workflows.data!.map((workflow) => workflow.id)).toContain(workflow_id);

    const kpis = await api.workflows[workflow_id]!.metrics.kpis.get({
      $query: range(),
      $headers: bearer(TEST_API_KEY),
    });
    expect(kpis.error).toBeNull();
    expect(kpis.data!.block_count).toBe(7);

    const overview = await api.resources.overview.get({
      $headers: bearer(TEST_API_KEY),
      $query: {
        from: new Date(Date.now() - 7 * 86_400_000).toISOString(),
        to: new Date().toISOString(),
      },
    });
    expect(overview.data!.workflows.map((workflow) => workflow.id)).toContain(workflow_id);
  });

  test('a rerun refreshes the seed spans and leaves every other span untouched', async () => {
    const token = TEST_API_KEY;
    const workflow_id = await seedDevTelemetry();

    const stale = 1_600_000_000_000_000_000n;
    await db
      .update(otelSpans)
      .set({ start_time_unix_nano: stale, end_time_unix_nano: stale + 1_000_000n })
      .where(like(otelSpans.span_id, `seed-${workflow_id}-%`));

    const foreign = {
      span_id: 'foreign-span',
      trace_id: 'foreign-trace',
      name: 'Foreign',
      start_time_unix_nano: stale,
      end_time_unix_nano: stale + 1_000_000n,
      attributes: { 'canyon.workflow.id': workflow_id },
    };
    await db.insert(otelSpans).values(foreign);
    const [before] = await db.select().from(otelSpans).where(eq(otelSpans.span_id, 'foreign-span'));

    const aged = (
      await api.workflows[workflow_id]!.metrics.kpis.get({
        $query: range(),
        $headers: bearer(token),
      })
    ).data!;
    expect(aged.block_count).toBe(0);

    await seedDevTelemetry();

    const refreshed = (
      await api.workflows[workflow_id]!.metrics.kpis.get({
        $query: range(),
        $headers: bearer(token),
      })
    ).data!;
    expect(refreshed.block_count).toBe(7);

    const [after] = await db.select().from(otelSpans).where(eq(otelSpans.span_id, 'foreign-span'));
    expect(after).toEqual(before);
  });

  test('a rerun restores a seed span field, not only its timestamps', async () => {
    const workflow_id = await seedDevTelemetry();
    const writer = eq(otelSpans.span_id, `seed-${workflow_id}-writer-a`);
    const [original] = await db.select().from(otelSpans).where(writer);

    await db.update(otelSpans).set({ name: 'Stale', attributes: {}, output: null }).where(writer);
    await seedDevTelemetry();

    const [restored] = await db.select().from(otelSpans).where(writer);
    expect(restored!.name).toBe(original!.name);
    expect(restored!.attributes).toEqual(original!.attributes);
    expect(restored!.output).toBe(original!.output);
  });

  test('the seed owns a deterministic version 8 workflow id', async () => {
    const token = TEST_API_KEY;
    const workflow_id = await seedDevTelemetry();
    expect(await seedDevTelemetry()).toBe(workflow_id);

    expect(workflow_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    const workflows = await api.workflows.get({ $headers: bearer(token) });
    expect(workflows.data!.filter((workflow) => workflow.id === workflow_id)).toHaveLength(1);
  });

  test('a workflow the user named after the demo stays separate from the seeded one', async () => {
    const token = TEST_API_KEY;
    const { workflow_id: my_workflow_id } = await create_test_workflow({
      name: 'Canyon Code Demo Flow',
    });

    const seeded_id = await seedDevTelemetry();
    expect(seeded_id).not.toBe(my_workflow_id);

    const mine_kpis = await api.workflows[my_workflow_id]!.metrics.kpis.get({
      $query: range(),
      $headers: bearer(token),
    });
    expect(mine_kpis.data!.block_count).toBe(0);

    const seeded_kpis = await api.workflows[seeded_id]!.metrics.kpis.get({
      $query: range(),
      $headers: bearer(token),
    });
    expect(seeded_kpis.data!.block_count).toBe(7);
  });

  test('the fleet overview counts the seeded workflow', async () => {
    const token = TEST_API_KEY;
    const workflow_id = await seedDevTelemetry();

    const overview = await api.resources.overview.get({
      $headers: bearer(token),
      $query: {
        from: new Date(Date.now() - 7 * 86_400_000).toISOString(),
        to: new Date().toISOString(),
      },
    });
    expect(overview.error).toBeNull();
    const seeded = overview.data!.workflows.find((row) => row.id === workflow_id);
    expect(seeded).toBeDefined();
    expect(seeded!.cost).toBeGreaterThan(0);
    expect(seeded!.error_rate_pct).toBeGreaterThan(0);
    expect(seeded!.avg_latency_ms).toBeGreaterThan(0);
  });

  // Two day-long demo seeds can outlast the default five-second timeout on a loaded machine.
  test('the monitoring demo seed fills the rollups the dashboard reads, and a rerun replaces them', async () => {
    const token = TEST_API_KEY;
    const { workflow_id } = await create_test_workflow({ name: 'Monitoring Demo' });
    await seedMonitoringDemo(workflow_id);

    const to = new Date();
    const resources = await api.workflows[workflow_id]!.monitoring.resources.get({
      $headers: bearer(token),
      $query: {
        from: new Date(to.getTime() - 86_400_000).toISOString(),
        to: to.toISOString(),
      },
    });
    expect(resources.error).toBeNull();
    expect(resources.data!.machines.length).toBeGreaterThan(0);

    const first = await rollup_totals(workflow_id);
    expect(first.rows).toBeGreaterThan(0);

    await seedMonitoringDemo(workflow_id);
    expect(await rollup_totals(workflow_id)).toEqual(first);
  }, 30_000);
});
