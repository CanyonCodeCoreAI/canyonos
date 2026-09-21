import { describe, expect, test } from 'bun:test';
import { eq, like } from 'drizzle-orm';

import { db } from '@api/db/client';
import { otelSpans } from '@api/db/schema';
import { seedDevTelemetry } from '@api/db/seed-telemetry';

import { api, setupE2ETests } from './e2e.setup';
import { authenticate, bearer } from './project-test.utils';

setupE2ETests();

async function seeded_company(email: string) {
  const token = await authenticate(email);
  const profile = await api.auth.profile.get({ $headers: bearer(token) });
  const company_id = profile.data?.company_id;
  const created_by = profile.data?.id;
  if (!company_id || !created_by) throw new Error('Seed fixture could not resolve a company');
  return { token, company_id, created_by };
}

describe('otel dev seed', () => {
  test('the seeded project reports its spans through the KPI endpoint', async () => {
    const { token, company_id, created_by } = await seeded_company('otel-seed-kpis@canyonos.test');
    const project_id = await seedDevTelemetry(company_id, created_by);

    const listed = await api.projects.get({ $headers: bearer(token) });
    expect(listed.data!.map((project) => project.id)).toContain(project_id);

    const kpis = await api.projects[project_id]!.metrics.kpis.get({ $headers: bearer(token) });
    expect(kpis.error).toBeNull();
    const window = kpis.data!.windows['7d'];
    expect(window.request_count).toBeGreaterThan(0);
    expect(window.block_count).toBeGreaterThan(0);
    expect(Number(window.total_cost)).toBeGreaterThan(0);
  });

  test('a rerun duplicates neither the project nor the telemetry counts', async () => {
    const { token, company_id, created_by } = await seeded_company('otel-seed-rerun@canyonos.test');
    const project_id = await seedDevTelemetry(company_id, created_by);

    const first_projects = await api.projects.get({ $headers: bearer(token) });
    const before = (await api.projects[project_id]!.metrics.kpis.get({ $headers: bearer(token) }))
      .data!.windows['7d'];

    expect(await seedDevTelemetry(company_id, created_by)).toBe(project_id);

    const after_projects = await api.projects.get({ $headers: bearer(token) });
    expect(after_projects.data).toHaveLength(first_projects.data!.length);
    const after = (await api.projects[project_id]!.metrics.kpis.get({ $headers: bearer(token) }))
      .data!.windows['7d'];
    expect(after.block_count).toBe(before.block_count);
    expect(after.request_count).toBe(before.request_count);
    expect(after.total_cost).toBe(before.total_cost);
  });

  test('the queries listing shows several seeded queries, one of them failed', async () => {
    const { token, company_id, created_by } = await seeded_company('otel-seed-list@canyonos.test');
    const project_id = await seedDevTelemetry(company_id, created_by);

    const listing = await api.projects[project_id]!.requests.get({
      $headers: bearer(token),
      $query: { limit: 20, offset: 0, time_window: '7d' },
    });
    expect(listing.error).toBeNull();
    expect(listing.data!.total).toBeGreaterThan(1);
    expect(listing.data!.items.map((item) => item.status)).toContain('failed');
    expect(listing.data!.items.some((item) => item.token_count > 0)).toBe(true);
  });

  test('a seeded query carries its own input and output', async () => {
    const { token, company_id, created_by } = await seeded_company('otel-seed-trace@canyonos.test');
    const project_id = await seedDevTelemetry(company_id, created_by);
    const listing = await api.projects[project_id]!.requests.get({
      $headers: bearer(token),
      $query: { limit: 20, offset: 0, time_window: '7d' },
    });

    const traces = await Promise.all(
      listing.data!.items.map((item) =>
        api.projects[project_id]!.requests[item.session_id]!.get({ $headers: bearer(token) })
      )
    );
    expect(traces.some((trace) => typeof trace.data?.input === 'string')).toBe(true);
    expect(traces.some((trace) => typeof trace.data?.output === 'string')).toBe(true);
  });

  test('the window reports an unpriced block rather than a free one', async () => {
    const { token, company_id, created_by } = await seeded_company(
      'otel-seed-unpriced@canyonos.test'
    );
    const project_id = await seedDevTelemetry(company_id, created_by);

    const window = (await api.projects[project_id]!.metrics.kpis.get({ $headers: bearer(token) }))
      .data!.windows['7d'];
    expect(window.costed_block_count).toBeGreaterThan(0);
    expect(window.costed_block_count).toBeLessThan(window.block_count);
    expect(window.tokens).toBeGreaterThan(0);
  });

  test('the flow reports an agent that answered under more than one id', async () => {
    const { token, company_id, created_by } = await seeded_company('otel-seed-flow@canyonos.test');
    const project_id = await seedDevTelemetry(company_id, created_by);

    const flow = await api.projects[project_id]!.metrics.flow.get({
      $headers: bearer(token),
      $query: { time_window: '7d' },
    });
    expect(flow.error).toBeNull();
    expect(flow.data!.nodes.some((node) => node.replica_count > 1)).toBe(true);
    expect(flow.data!.edges.length).toBeGreaterThan(0);
  });

  test('another company reads the seeded project and its spans', async () => {
    const seeded = await seeded_company('otel-seed-owner@canyonos.test');
    const project_id = await seedDevTelemetry(seeded.company_id, seeded.created_by);
    const other = await seeded_company('otel-seed-outsider@canyonos.test');

    const projects = await api.projects.get({ $headers: bearer(other.token) });
    expect(projects.data!.map((project) => project.id)).toContain(project_id);

    const kpis = await api.projects[project_id]!.metrics.kpis.get({
      $headers: bearer(other.token),
    });
    expect(kpis.error).toBeNull();
    expect(kpis.data!.windows['7d'].block_count).toBe(7);

    const overview = await api.resources.overview.get({
      $headers: bearer(other.token),
      $query: { time_window: '7d' },
    });
    expect(overview.data!.projects.map((project) => project.id)).toContain(project_id);
  });

  test('a rerun refreshes the seed spans and leaves every other span untouched', async () => {
    const { token, company_id, created_by } = await seeded_company(
      'otel-seed-refresh@canyonos.test'
    );
    const project_id = await seedDevTelemetry(company_id, created_by);

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

    const aged = (await api.projects[project_id]!.metrics.kpis.get({ $headers: bearer(token) }))
      .data!.windows['7d'];
    expect(aged.block_count).toBe(0);

    await seedDevTelemetry(company_id, created_by);

    const refreshed = (
      await api.projects[project_id]!.metrics.kpis.get({ $headers: bearer(token) })
    ).data!.windows['7d'];
    expect(refreshed.block_count).toBe(7);

    const [after] = await db.select().from(otelSpans).where(eq(otelSpans.span_id, 'foreign-span'));
    expect(after).toEqual(before);
  });

  test('a rerun restores a seed span field, not only its timestamps', async () => {
    const { company_id, created_by } = await seeded_company('otel-seed-stale@canyonos.test');
    const project_id = await seedDevTelemetry(company_id, created_by);
    const writer = eq(otelSpans.span_id, `seed-${project_id}-writer-a`);
    const [original] = await db.select().from(otelSpans).where(writer);

    await db.update(otelSpans).set({ name: 'Stale', attributes: {}, output: null }).where(writer);
    await seedDevTelemetry(company_id, created_by);

    const [restored] = await db.select().from(otelSpans).where(writer);
    expect(restored!.name).toBe(original!.name);
    expect(restored!.attributes).toEqual(original!.attributes);
    expect(restored!.output).toBe(original!.output);
  });

  test('the seed owns a deterministic version 8 project id', async () => {
    const { token, company_id, created_by } = await seeded_company('otel-seed-id@canyonos.test');
    const project_id = await seedDevTelemetry(company_id, created_by);
    expect(await seedDevTelemetry(company_id, created_by)).toBe(project_id);

    expect(project_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    const projects = await api.projects.get({ $headers: bearer(token) });
    expect(projects.data!.filter((project) => project.id === project_id)).toHaveLength(1);
  });

  test('a project the user named after the demo stays separate from the seeded one', async () => {
    const { token, company_id, created_by } = await seeded_company('otel-seed-name@canyonos.test');
    const mine = await api.projects.post(
      {
        name: 'Canyon Code Demo Flow',
        files: [{ path: 'workflow.py', content: 'def run(): pass\n' }],
      },
      { headers: bearer(token) }
    );
    const my_project_id = mine.data!.project.id;

    const seeded_id = await seedDevTelemetry(company_id, created_by);
    expect(seeded_id).not.toBe(my_project_id);

    const mine_kpis = await api.projects[my_project_id]!.metrics.kpis.get({
      $headers: bearer(token),
    });
    expect(mine_kpis.data!.windows['7d'].block_count).toBe(0);

    const seeded_kpis = await api.projects[seeded_id]!.metrics.kpis.get({
      $headers: bearer(token),
    });
    expect(seeded_kpis.data!.windows['7d'].block_count).toBe(7);
  });

  test('the fleet overview counts the seeded project', async () => {
    const { token, company_id, created_by } = await seeded_company('otel-seed-fleet@canyonos.test');
    const project_id = await seedDevTelemetry(company_id, created_by);

    const overview = await api.resources.overview.get({
      $headers: bearer(token),
      $query: { time_window: '7d' },
    });
    expect(overview.error).toBeNull();
    const seeded = overview.data!.projects.find((row) => row.id === project_id);
    expect(seeded).toBeDefined();
    expect(seeded!.cost).toBeGreaterThan(0);
    expect(seeded!.error_rate_pct).toBeGreaterThan(0);
    expect(seeded!.avg_latency_ms).toBeGreaterThan(0);
  });
});
