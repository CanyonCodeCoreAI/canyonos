// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test';
import { eq, like } from 'drizzle-orm';

import { db } from '@api/db/client';
import { otelSpans } from '@api/db/schema';
import { seedDevTelemetry } from '@api/db/seed-telemetry';

import { api, setupE2ETests } from './e2e.setup';
import { authenticate, bearer, create_test_project } from './project-test.utils';

setupE2ETests();

const range = () => {
  const to = new Date();
  return {
    from: new Date(to.getTime() - 7 * 86_400_000).toISOString(),
    to: to.toISOString(),
  };
};

describe('otel dev seed', () => {
  test('the seeded project reports its spans through the KPI endpoint', async () => {
    const token = await authenticate('otel-seed-kpis@canyonos.test');
    const project_id = await seedDevTelemetry();

    const listed = await api.projects.get({ $headers: bearer(token) });
    expect(listed.data!.map((project) => project.id)).toContain(project_id);

    const kpis = await api.projects[project_id]!.metrics.kpis.get({
      $query: range(),
      $headers: bearer(token),
    });
    expect(kpis.error).toBeNull();
    const window = kpis.data!;
    expect(window.request_count).toBeGreaterThan(0);
    expect(window.block_count).toBeGreaterThan(0);
    expect(Number(window.total_cost)).toBeGreaterThan(0);
  });

  test('a rerun duplicates neither the project nor the telemetry counts', async () => {
    const token = await authenticate('otel-seed-rerun@canyonos.test');
    const project_id = await seedDevTelemetry();

    const first_projects = await api.projects.get({ $headers: bearer(token) });
    const before = (
      await api.projects[project_id]!.metrics.kpis.get({ $query: range(), $headers: bearer(token) })
    ).data!;

    expect(await seedDevTelemetry()).toBe(project_id);

    const after_projects = await api.projects.get({ $headers: bearer(token) });
    expect(after_projects.data).toHaveLength(first_projects.data!.length);
    const after = (
      await api.projects[project_id]!.metrics.kpis.get({ $query: range(), $headers: bearer(token) })
    ).data!;
    expect(after.block_count).toBe(before.block_count);
    expect(after.request_count).toBe(before.request_count);
    expect(after.total_cost).toBe(before.total_cost);
  });

  test('the queries listing shows several seeded queries, one of them failed', async () => {
    const token = await authenticate('otel-seed-list@canyonos.test');
    const project_id = await seedDevTelemetry();

    const listing = await api.projects[project_id]!.requests.get({
      $headers: bearer(token),
      $query: { limit: 20, offset: 0, ...range() },
    });
    expect(listing.error).toBeNull();
    expect(listing.data!.total).toBeGreaterThan(1);
    expect(listing.data!.items.map((item) => item.status)).toContain('failed');
    expect(listing.data!.items.some((item) => item.token_count > 0)).toBe(true);
  });

  test('a seeded query carries its own input and output', async () => {
    const token = await authenticate('otel-seed-trace@canyonos.test');
    const project_id = await seedDevTelemetry();
    const listing = await api.projects[project_id]!.requests.get({
      $headers: bearer(token),
      $query: { limit: 20, offset: 0, ...range() },
    });

    const traces = await Promise.all(
      listing.data!.items.map((item) =>
        api.projects[project_id]!.requests[item.session_id]!.get({
          $query: range(),
          $headers: bearer(token),
        })
      )
    );
    expect(traces.some((trace) => typeof trace.data?.input === 'string')).toBe(true);
    expect(traces.some((trace) => typeof trace.data?.output === 'string')).toBe(true);
  });

  test('the window reports an unpriced block rather than a free one', async () => {
    const token = await authenticate('otel-seed-unpriced@canyonos.test');
    const project_id = await seedDevTelemetry();

    const window = (
      await api.projects[project_id]!.metrics.kpis.get({ $query: range(), $headers: bearer(token) })
    ).data!;
    expect(window.costed_block_count).toBeGreaterThan(0);
    expect(window.costed_block_count).toBeLessThan(window.block_count);
    expect(window.tokens).toBeGreaterThan(0);
  });

  test('the agent drawer reports an agent that answered under more than one id', async () => {
    const token = await authenticate('otel-seed-replicas@canyonos.test');
    const project_id = await seedDevTelemetry();

    const blocks = await api.projects[project_id]!.metrics.blocks.get({
      $headers: bearer(token),
      $query: { ...range() },
    });
    expect(blocks.error).toBeNull();

    const replica_counts = await Promise.all(
      [...new Set(blocks.data!.blocks.map((block) => block.agent_id))].map(async (agent_id) => {
        const drawer = await api.projects[project_id]!.metrics.agents[agent_id]!.get({
          $query: range(),
          $headers: bearer(token),
        });
        expect(drawer.error).toBeNull();
        return drawer.data!.agent.replica_count;
      })
    );
    expect(replica_counts.some((count) => count > 1)).toBe(true);
  });

  test('any signed-in user reads the seeded project and its spans', async () => {
    const project_id = await seedDevTelemetry();
    const other = { token: await authenticate('otel-seed-outsider@canyonos.test') };

    const projects = await api.projects.get({ $headers: bearer(other.token) });
    expect(projects.data!.map((project) => project.id)).toContain(project_id);

    const kpis = await api.projects[project_id]!.metrics.kpis.get({
      $query: range(),
      $headers: bearer(other.token),
    });
    expect(kpis.error).toBeNull();
    expect(kpis.data!.block_count).toBe(7);

    const overview = await api.resources.overview.get({
      $headers: bearer(other.token),
      $query: {
        from: new Date(Date.now() - 7 * 86_400_000).toISOString(),
        to: new Date().toISOString(),
      },
    });
    expect(overview.data!.projects.map((project) => project.id)).toContain(project_id);
  });

  test('a rerun refreshes the seed spans and leaves every other span untouched', async () => {
    const token = await authenticate('otel-seed-refresh@canyonos.test');
    const project_id = await seedDevTelemetry();

    const stale = 1_600_000_000_000_000_000n;
    await db
      .update(otelSpans)
      .set({ start_time_unix_nano: stale, end_time_unix_nano: stale + 1_000_000n })
      .where(like(otelSpans.span_id, `seed-${project_id}-%`));

    const foreign = {
      span_id: 'foreign-span',
      trace_id: 'foreign-trace',
      name: 'Foreign',
      start_time_unix_nano: stale,
      end_time_unix_nano: stale + 1_000_000n,
      attributes: { 'canyon.project.id': project_id },
    };
    await db.insert(otelSpans).values(foreign);
    const [before] = await db.select().from(otelSpans).where(eq(otelSpans.span_id, 'foreign-span'));

    const aged = (
      await api.projects[project_id]!.metrics.kpis.get({ $query: range(), $headers: bearer(token) })
    ).data!;
    expect(aged.block_count).toBe(0);

    await seedDevTelemetry();

    const refreshed = (
      await api.projects[project_id]!.metrics.kpis.get({ $query: range(), $headers: bearer(token) })
    ).data!;
    expect(refreshed.block_count).toBe(7);

    const [after] = await db.select().from(otelSpans).where(eq(otelSpans.span_id, 'foreign-span'));
    expect(after).toEqual(before);
  });

  test('a rerun restores a seed span field, not only its timestamps', async () => {
    const project_id = await seedDevTelemetry();
    const writer = eq(otelSpans.span_id, `seed-${project_id}-writer-a`);
    const [original] = await db.select().from(otelSpans).where(writer);

    await db.update(otelSpans).set({ name: 'Stale', attributes: {}, output: null }).where(writer);
    await seedDevTelemetry();

    const [restored] = await db.select().from(otelSpans).where(writer);
    expect(restored!.name).toBe(original!.name);
    expect(restored!.attributes).toEqual(original!.attributes);
    expect(restored!.output).toBe(original!.output);
  });

  test('the seed owns a deterministic version 8 project id', async () => {
    const token = await authenticate('otel-seed-id@canyonos.test');
    const project_id = await seedDevTelemetry();
    expect(await seedDevTelemetry()).toBe(project_id);

    expect(project_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    const projects = await api.projects.get({ $headers: bearer(token) });
    expect(projects.data!.filter((project) => project.id === project_id)).toHaveLength(1);
  });

  test('a project the user named after the demo stays separate from the seeded one', async () => {
    const token = await authenticate('otel-seed-name@canyonos.test');
    const { project_id: my_project_id } = await create_test_project(token, {
      name: 'Canyon Code Demo Flow',
    });

    const seeded_id = await seedDevTelemetry();
    expect(seeded_id).not.toBe(my_project_id);

    const mine_kpis = await api.projects[my_project_id]!.metrics.kpis.get({
      $query: range(),
      $headers: bearer(token),
    });
    expect(mine_kpis.data!.block_count).toBe(0);

    const seeded_kpis = await api.projects[seeded_id]!.metrics.kpis.get({
      $query: range(),
      $headers: bearer(token),
    });
    expect(seeded_kpis.data!.block_count).toBe(7);
  });

  test('the fleet overview counts the seeded project', async () => {
    const token = await authenticate('otel-seed-fleet@canyonos.test');
    const project_id = await seedDevTelemetry();

    const overview = await api.resources.overview.get({
      $headers: bearer(token),
      $query: {
        from: new Date(Date.now() - 7 * 86_400_000).toISOString(),
        to: new Date().toISOString(),
      },
    });
    expect(overview.error).toBeNull();
    const seeded = overview.data!.projects.find((row) => row.id === project_id);
    expect(seeded).toBeDefined();
    expect(seeded!.cost).toBeGreaterThan(0);
    expect(seeded!.error_rate_pct).toBeGreaterThan(0);
    expect(seeded!.avg_latency_ms).toBeGreaterThan(0);
  });
});
