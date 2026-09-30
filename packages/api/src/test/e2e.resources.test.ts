import { describe, expect, test } from 'bun:test';

import { db } from '@api/db/client';
import { otelSpans, projects } from '@api/db/schema';
import { GEN_AI, PROJECT_ID_ATTRIBUTE } from '@api/modules/metrics/metrics.contract';

import { api, setupE2ETests } from './e2e.setup';
import { authenticate, bearer } from './project-test.utils';
import { write_project_span, write_unattributed_span } from './telemetry-test.utils';

setupE2ETests();

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const NANOS_PER_MS = 1_000_000n;

// One frozen reference so every seeded timestamp is derived from the same instant, not from the
// wall clock as each insert runs.
const BASE_MS = Date.now();
const at = (ms_ago: number): string => new Date(BASE_MS - ms_ago).toISOString();
const nanos_ago = (ms_ago: number): bigint => BigInt(BASE_MS - Math.round(ms_ago)) * NANOS_PER_MS;

interface SpanSeed {
  span_id: string;
  trace_id: string;
  ms_ago: number;
  duration_ms: number;
  input_tokens?: number;
  output_tokens?: number;
  cost?: number;
  failed?: boolean;
}

async function authed_company(
  email: string,
  onboard = true
): Promise<{ token: string; company_id: string | null; user_id: string }> {
  const token = await authenticate(email, onboard);
  const profile = await api.auth.profile.get({ $headers: bearer(token) });
  expect(profile.error).toBeNull();
  return { token, company_id: profile.data!.company_id ?? null, user_id: profile.data!.id };
}

async function insert_project(
  company_id: string,
  user_id: string,
  name: string,
  ms_ago: number
): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(projects).values({
    id,
    company_id,
    created_by: user_id,
    name,
    created_at: at(ms_ago),
    updated_at: at(ms_ago),
  });
  return id;
}

async function insert_span(project_id: string, span: SpanSeed): Promise<void> {
  const start = nanos_ago(span.ms_ago);
  await write_project_span(project_id, {
    span_id: span.span_id,
    trace_id: span.trace_id,
    start_time_unix_nano: start,
    end_time_unix_nano: start + BigInt(span.duration_ms) * NANOS_PER_MS,
    input_tokens: span.input_tokens,
    output_tokens: span.output_tokens,
    cost: span.cost,
    failed: span.failed,
  });
}

type Window = '1d' | '7d' | '30d' | '1q';

const overview = (token: string, time_window: Window) =>
  api.resources.overview.get({ $headers: bearer(token), $query: { time_window } });

const tokens_usage = (project: {
  resource_usage: { resource_id: string; usage: number }[];
}): number => project.resource_usage.find((usage) => usage.resource_id === 'tokens')!.usage;

// The fleet spans the whole install, so every assertion below picks the rows the test seeded.
type FleetProject = NonNullable<Awaited<ReturnType<typeof overview>>['data']>['projects'][number];

const fleet_row = (data: { projects: FleetProject[] }, project_id: string): FleetProject =>
  data.projects.find((project) => project.id === project_id)!;

const fleet_rows = (data: { projects: FleetProject[] }, ids: string[]): FleetProject[] =>
  data.projects.filter((project) => ids.includes(project.id));

describe('GET /resources/overview', () => {
  test('a request without a token is rejected with 401', async () => {
    const res = await api.resources.overview.get({ $query: { time_window: '30d' } });
    expect(res.error?.status as number).toBe(401);
  });

  test('derives per-project cost, requests and tokens from project spans', async () => {
    const { token, company_id, user_id } = await authed_company('fleet-owner@canyonos.test');

    const alpha = await insert_project(company_id!, user_id, 'Alpha', 3 * DAY_MS);
    const bravo = await insert_project(company_id!, user_id, 'Bravo', 2 * DAY_MS);
    const charlie = await insert_project(company_id!, user_id, 'Charlie', 1 * DAY_MS);

    await insert_span(alpha, {
      span_id: 'fleet-a1-s',
      trace_id: 'fleet-a1',
      ms_ago: 2 * HOUR_MS,
      duration_ms: 1000,
      input_tokens: 800_000,
      cost: 0.6,
    });
    await insert_span(alpha, {
      span_id: 'fleet-a2-s',
      trace_id: 'fleet-a2',
      ms_ago: 3 * HOUR_MS,
      duration_ms: 3000,
      input_tokens: 400_000,
      cost: 0.4,
    });
    await insert_span(bravo, {
      span_id: 'fleet-b1-s',
      trace_id: 'fleet-b1',
      ms_ago: 2 * HOUR_MS,
      duration_ms: 2000,
      input_tokens: 300_000,
      cost: 1,
    });

    const res = await overview(token, '30d');
    expect(res.error).toBeNull();
    const data = res.data!;

    const mine = fleet_rows(data, [alpha, bravo, charlie]);
    expect(data.time_window).toBe('30d');
    expect(mine.map((project) => project.id)).toEqual([alpha, bravo, charlie]);
    expect(mine.map((project) => project.name)).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(mine.map((project) => project.requests)).toEqual([2, 1, 0]);
    expect(mine.map((project) => project.cost)).toEqual([1, 1, 0]);
    expect(mine.map((project) => tokens_usage(project))).toEqual([1.2, 0.3, 0]);
    expect(mine.map((project) => project.avg_latency_ms)).toEqual([2000, 2000, 0]);
    expect(mine.every((project) => project.error_rate_pct === 0)).toBe(true);

    const untracked = data.resources.filter((resource) => resource.id !== 'tokens');
    expect(untracked.map((resource) => resource.id)).toEqual(['gpu', 'cpu', 'mem', 'storage']);
    expect(untracked.every((resource) => resource.available === false)).toBe(true);
    expect(untracked.every((resource) => resource.pool === 0)).toBe(true);
    for (const project of mine) {
      const untracked_usage = project.resource_usage.filter(
        (usage) => usage.resource_id !== 'tokens'
      );
      expect(untracked_usage.every((usage) => usage.usage === 0)).toBe(true);
    }

    expect(data.resources.find((resource) => resource.id === 'tokens')).toMatchObject({
      available: true,
      unit: 'M',
    });
  });

  test('two spans in one trace count as one request', async () => {
    const { token, company_id, user_id } = await authed_company('fleet-one-trace@canyonos.test');
    const project = await insert_project(company_id!, user_id, 'OneTrace', DAY_MS);

    await insert_span(project, {
      span_id: 'one-trace-a',
      trace_id: 'one-trace',
      ms_ago: 2 * HOUR_MS,
      duration_ms: 1000,
      input_tokens: 100,
      cost: 0.1,
    });
    await insert_span(project, {
      span_id: 'one-trace-b',
      trace_id: 'one-trace',
      ms_ago: 2 * HOUR_MS,
      duration_ms: 3000,
      input_tokens: 300,
      cost: 0.3,
    });

    const res = await overview(token, '30d');
    expect(res.error).toBeNull();
    const project_row = fleet_row(res.data!, project);

    expect(project_row.requests).toBe(1);
    expect(project_row.cost).toBe(0.4);
    // Latency stays a per-span average across both spans, not a per-trace wall clock.
    expect(project_row.avg_latency_ms).toBe(2000);
  });

  test('a span with no canyon.project.id is invisible', async () => {
    const { token, company_id, user_id } = await authed_company('fleet-orphan@canyonos.test');
    const project = await insert_project(company_id!, user_id, 'Owned', DAY_MS);

    await insert_span(project, {
      span_id: 'orphan-owned',
      trace_id: 'orphan-owned-trace',
      ms_ago: 2 * HOUR_MS,
      duration_ms: 1000,
      input_tokens: 100,
      cost: 0.1,
    });
    await write_unattributed_span({
      span_id: 'orphan-loose',
      trace_id: 'orphan-loose-trace',
      start_time_unix_nano: nanos_ago(2 * HOUR_MS),
      end_time_unix_nano: nanos_ago(2 * HOUR_MS) + 9000n * NANOS_PER_MS,
      input_tokens: 999_000,
      cost: 9.99,
    });

    const res = await overview(token, '30d');
    expect(res.error).toBeNull();
    const project_row = fleet_row(res.data!, project);

    expect(project_row.requests).toBe(1);
    expect(project_row.cost).toBe(0.1);
    expect(tokens_usage(project_row)).toBe(0);
    expect(project_row.avg_latency_ms).toBe(1000);
  });

  test('one trace id in two projects stays isolated', async () => {
    const { token, company_id, user_id } = await authed_company('fleet-shared@canyonos.test');
    const first = await insert_project(company_id!, user_id, 'First', 2 * DAY_MS);
    const second = await insert_project(company_id!, user_id, 'Second', DAY_MS);

    await insert_span(first, {
      span_id: 'shared-first',
      trace_id: 'shared-trace',
      ms_ago: 2 * HOUR_MS,
      duration_ms: 1000,
      input_tokens: 100_000,
      cost: 0.1,
    });
    await insert_span(second, {
      span_id: 'shared-second',
      trace_id: 'shared-trace',
      ms_ago: 2 * HOUR_MS,
      duration_ms: 3000,
      input_tokens: 300_000,
      cost: 0.3,
    });

    const res = await overview(token, '30d');
    expect(res.error).toBeNull();
    const first_row = fleet_row(res.data!, first);
    const second_row = fleet_row(res.data!, second);

    expect(first_row).toMatchObject({ requests: 1, cost: 0.1, avg_latency_ms: 1000 });
    expect(second_row).toMatchObject({ requests: 1, cost: 0.3, avg_latency_ms: 3000 });
    expect(tokens_usage(first_row)).toBe(0.1);
    expect(tokens_usage(second_row)).toBe(0.3);
  });

  test("another company's project appears with its own totals", async () => {
    const mine = await authed_company('fleet-mine@canyonos.test');
    const theirs = await authed_company('fleet-theirs@canyonos.test');
    const my_project = await insert_project(mine.company_id!, mine.user_id, 'Mine', DAY_MS);
    const their_project = await insert_project(
      theirs.company_id!,
      theirs.user_id,
      'Theirs',
      DAY_MS
    );

    await insert_span(my_project, {
      span_id: 'mine-s',
      trace_id: 'mine-trace',
      ms_ago: 2 * HOUR_MS,
      duration_ms: 1000,
      input_tokens: 100,
      cost: 0.1,
    });
    await insert_span(their_project, {
      span_id: 'theirs-s',
      trace_id: 'theirs-trace',
      ms_ago: 2 * HOUR_MS,
      duration_ms: 1000,
      input_tokens: 500,
      cost: 5,
    });

    const res = await overview(mine.token, '30d');
    expect(res.error).toBeNull();
    expect(fleet_row(res.data!, my_project).cost).toBe(0.1);
    expect(fleet_row(res.data!, their_project)).toMatchObject({ name: 'Theirs', cost: 5 });
  });

  test('a narrow window excludes older spans', async () => {
    const { token, company_id, user_id } = await authed_company('fleet-window@canyonos.test');
    const project = await insert_project(company_id!, user_id, 'Windowed', 40 * DAY_MS);

    await insert_span(project, {
      span_id: 'win-recent-s',
      trace_id: 'win-recent',
      ms_ago: 2 * HOUR_MS,
      duration_ms: 1000,
      input_tokens: 100_000,
      cost: 0.1,
    });
    await insert_span(project, {
      span_id: 'win-older-s',
      trace_id: 'win-older',
      ms_ago: 3 * DAY_MS,
      duration_ms: 1000,
      input_tokens: 200_000,
      cost: 0.2,
    });

    const day = await overview(token, '1d');
    expect(day.error).toBeNull();
    expect(fleet_row(day.data!, project).requests).toBe(1);
    expect(tokens_usage(fleet_row(day.data!, project))).toBe(0.1);

    const week = await overview(token, '7d');
    expect(week.error).toBeNull();
    expect(fleet_row(week.data!, project).requests).toBe(2);
    expect(tokens_usage(fleet_row(week.data!, project))).toBe(0.3);
  });

  test('an ERROR status span drives the error rate', async () => {
    const { token, company_id, user_id } = await authed_company('fleet-errors@canyonos.test');
    const project = await insert_project(company_id!, user_id, 'Erroring', DAY_MS);

    await insert_span(project, {
      span_id: 'err-ok-1',
      trace_id: 'err-trace',
      ms_ago: 2 * HOUR_MS,
      duration_ms: 1000,
      input_tokens: 10,
      cost: 0.01,
    });
    await insert_span(project, {
      span_id: 'err-ok-2',
      trace_id: 'err-trace',
      ms_ago: 2 * HOUR_MS,
      duration_ms: 1000,
      input_tokens: 10,
      cost: 0.01,
    });
    await insert_span(project, {
      span_id: 'err-failed',
      trace_id: 'err-trace',
      ms_ago: 2 * HOUR_MS,
      duration_ms: 1000,
      input_tokens: 10,
      cost: 0.01,
      failed: true,
    });

    const res = await overview(token, '30d');
    expect(res.error).toBeNull();
    expect(fleet_row(res.data!, project).error_rate_pct).toBeCloseTo(100 / 3, 10);
  });

  test('tokens sum input and output, and latency averages the span durations', async () => {
    const { token, company_id, user_id } = await authed_company('fleet-derive@canyonos.test');
    const project = await insert_project(company_id!, user_id, 'Derived', DAY_MS);

    await insert_span(project, {
      span_id: 'derive-both',
      trace_id: 'derive-a',
      ms_ago: 2 * HOUR_MS,
      duration_ms: 400,
      input_tokens: 400_000,
      output_tokens: 100_000,
      cost: 0.5,
    });
    await insert_span(project, {
      span_id: 'derive-none',
      trace_id: 'derive-b',
      ms_ago: 2 * HOUR_MS,
      duration_ms: 800,
      cost: 0.5,
    });

    const res = await overview(token, '30d');
    expect(res.error).toBeNull();
    const project_row = fleet_row(res.data!, project);

    expect(tokens_usage(project_row)).toBe(0.5);
    expect(project_row.avg_latency_ms).toBe(600);
    expect(project_row.cost).toBe(1);
  });

  test('attributes of the wrong type and invalid counts are absent, not a failure', async () => {
    const { token, company_id, user_id } = await authed_company('fleet-malformed@canyonos.test');
    const project = await insert_project(company_id!, user_id, 'Malformed', DAY_MS);

    const start = nanos_ago(2 * HOUR_MS);
    await db.insert(otelSpans).values({
      span_id: 'malformed-s',
      trace_id: 'malformed-trace',
      name: 'malformed',
      start_time_unix_nano: start,
      end_time_unix_nano: start + 500n * NANOS_PER_MS,
      attributes: {
        [PROJECT_ID_ATTRIBUTE]: project,
        [GEN_AI.USAGE_COST]: 'free',
        [GEN_AI.INPUT_TOKENS]: { count: 5 },
        [GEN_AI.OUTPUT_TOKENS]: ['7'],
      },
    });
    await insert_span(project, {
      span_id: 'malformed-counts',
      trace_id: 'malformed-counts-trace',
      ms_ago: 2 * HOUR_MS,
      duration_ms: 500,
      input_tokens: -5,
      output_tokens: 1.5,
      cost: 0.25,
    });

    const res = await overview(token, '30d');
    expect(res.error).toBeNull();
    const project_row = fleet_row(res.data!, project);

    expect(project_row.requests).toBe(2);
    expect(tokens_usage(project_row)).toBe(0);
    expect(project_row.cost).toBe(0.25);
    expect(project_row.avg_latency_ms).toBe(500);
    expect(project_row.error_rate_pct).toBe(0);
  });

  test('a user with no company sees the same fleet as everyone else', async () => {
    const owner = await authed_company('fleet-shared-owner@canyonos.test');
    const owned = await insert_project(owner.company_id!, owner.user_id, 'Shared Fleet', DAY_MS);
    await insert_span(owned, {
      span_id: 'shared-fleet-s',
      trace_id: 'shared-fleet-trace',
      ms_ago: 2 * HOUR_MS,
      duration_ms: 1000,
      input_tokens: 100,
      cost: 0.2,
    });

    const { token, company_id } = await authed_company('fleet-no-company@canyonos.test', false);
    expect(company_id).toBeNull();

    const res = await overview(token, '30d');
    expect(res.error).toBeNull();
    expect(fleet_row(res.data!, owned)).toMatchObject({ name: 'Shared Fleet', cost: 0.2 });
    expect(res.data!.resources.map((resource) => resource.id)).toEqual([
      'gpu',
      'cpu',
      'mem',
      'storage',
      'tokens',
    ]);
  });
});
