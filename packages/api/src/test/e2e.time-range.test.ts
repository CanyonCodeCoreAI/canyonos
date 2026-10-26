// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test';

import { api, setupE2ETests } from './e2e.setup';
import { authenticate, bearer, create_test_project } from './project-test.utils';
import { write_project_span } from './telemetry-test.utils';

setupE2ETests();

// The range contract every dashboard read shares. The per-module files cover what each endpoint
// returns; this one covers what they must agree on.

const NANOS_PER_MS = 1_000_000n;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const nanos = (iso: string): bigint => BigInt(Date.parse(iso)) * NANOS_PER_MS;
const plus_ms = (at: bigint, ms: number): bigint => at + BigInt(ms) * NANOS_PER_MS;
const iso = (ms: number): string => new Date(ms).toISOString();

type Range = { from: string; to: string };

const range_ending = (to: string, length_ms: number): Range => ({
  from: iso(Date.parse(to) - length_ms),
  to,
});

interface RequestFixture {
  readonly trace_id: string;
  readonly start: bigint;
  readonly cost: number;
  /** Where the model span starts; the root block starts at `start` and carries no cost. */
  readonly model_at?: bigint;
}

/** Span ids are unique across the whole table, so a fixture's name is scoped to its project. */
const trace_key = (project_id: string, name: string): string => `${project_id.slice(0, 8)}-${name}`;

/** One request: a root block and one model call carrying the whole cost. */
async function write_request(project_id: string, request: RequestFixture): Promise<void> {
  const trace_id = trace_key(project_id, request.trace_id);
  const model_at = request.model_at ?? plus_ms(request.start, 100);
  await write_project_span(project_id, {
    span_id: `${trace_id}-root`,
    trace_id,
    name: 'Workflow.main',
    start_time_unix_nano: request.start,
    end_time_unix_nano: plus_ms(model_at, 1000),
  });
  await write_project_span(project_id, {
    span_id: `${trace_id}-model`,
    trace_id,
    name: 'Workflow.main',
    model: 'gpt-4',
    input_tokens: 10,
    output_tokens: 5,
    cost: request.cost,
    token_cost: request.cost,
    start_time_unix_nano: model_at,
    end_time_unix_nano: plus_ms(model_at, 500),
  });
}

let next_project = 0;

async function project(): Promise<{ token: string; project_id: string }> {
  next_project += 1;
  const token = await authenticate(`time-range-${next_project}-${Date.now()}@canyonos.test`);
  const { project_id } = await create_test_project(token, { name: `Range ${next_project}` });
  return { token, project_id };
}

const money = (value: string | null | undefined): number => Number(value ?? 0);

const sum = <T>(rows: readonly T[], pick: (row: T) => number): number =>
  rows.reduce((total, row) => total + pick(row), 0);

/** What every request-level reader reports for one range: the request count and the cost. */
async function request_readers(token: string, project_id: string, range: Range) {
  const headers = bearer(token);
  const scoped = api.projects[project_id]!;
  const [kpis, timeseries, blocks, listing, traces, llm, fleet] = await Promise.all([
    scoped.metrics.kpis.get({ $query: range, $headers: headers }),
    scoped.metrics.timeseries.get({ $query: range, $headers: headers }),
    scoped.metrics.blocks.get({ $query: range, $headers: headers }),
    scoped.requests.get({ $query: { ...range, limit: 100, offset: 0 }, $headers: headers }),
    scoped.monitoring.traces.get({ $query: { ...range, limit: 100 }, $headers: headers }),
    scoped.monitoring.llm.get({ $query: { ...range, limit: 100 }, $headers: headers }),
    api.resources.overview.get({ $query: range, $headers: headers }),
  ]);
  const fleet_row = fleet.data!.projects.find((row) => row.id === project_id);
  return {
    kpis: { requests: kpis.data!.request_count, cost: money(kpis.data!.total_cost) },
    timeseries: {
      requests: sum(timeseries.data!.points, (point) => point.request_count),
      cost: sum(timeseries.data!.points, (point) => money(point.total_cost)),
    },
    blocks: { cost: money(blocks.data!.total_cost) },
    listing: {
      requests: listing.data!.total,
      cost: sum(listing.data!.items, (item) => money(item.total_cost)),
    },
    traces: { requests: traces.data!.traces.length },
    llm: { requests: llm.data!.calls.length },
    fleet: { requests: fleet_row?.requests ?? 0, cost: fleet_row?.cost ?? 0 },
  };
}

function expect_readers_agree(
  readers: Awaited<ReturnType<typeof request_readers>>,
  expected: { requests: number; cost: number }
): void {
  expect(readers.kpis.requests).toBe(expected.requests);
  expect(readers.timeseries.requests).toBe(expected.requests);
  expect(readers.listing.requests).toBe(expected.requests);
  expect(readers.traces.requests).toBe(expected.requests);
  expect(readers.llm.requests).toBe(expected.requests);
  expect(readers.fleet.requests).toBe(expected.requests);
  expect(readers.kpis.cost).toBeCloseTo(expected.cost, 9);
  expect(readers.timeseries.cost).toBeCloseTo(expected.cost, 9);
  expect(readers.blocks.cost).toBeCloseTo(expected.cost, 9);
  expect(readers.listing.cost).toBeCloseTo(expected.cost, 9);
  expect(readers.fleet.cost).toBeCloseTo(expected.cost, 9);
}

describe('which requests a range holds', () => {
  const DAY_ONE: Range = { from: '2026-06-01T00:00:00.000Z', to: '2026-06-02T00:00:00.000Z' };
  const DAY_TWO: Range = { from: '2026-06-02T00:00:00.000Z', to: '2026-06-03T00:00:00.000Z' };

  test('a range is half-open: a request starting at `from` is in, one starting at `to` is out', async () => {
    const { token, project_id } = await project();
    await write_request(project_id, { trace_id: 'at-from', start: nanos(DAY_ONE.from), cost: 1 });
    await write_request(project_id, { trace_id: 'at-to', start: nanos(DAY_ONE.to), cost: 2 });

    expect_readers_agree(await request_readers(token, project_id, DAY_ONE), {
      requests: 1,
      cost: 1,
    });
  });

  test('a request belongs whole to the range it started in, even when its cost falls after `to`', async () => {
    const { token, project_id } = await project();
    await write_request(project_id, {
      trace_id: 'straddling',
      start: nanos('2026-06-01T23:59:30.000Z'),
      model_at: nanos('2026-06-02T00:00:10.000Z'),
      cost: 0.5,
    });

    expect_readers_agree(await request_readers(token, project_id, DAY_ONE), {
      requests: 1,
      cost: 0.5,
    });
    expect_readers_agree(await request_readers(token, project_id, DAY_TWO), {
      requests: 0,
      cost: 0,
    });
  });

  test('a request starting in the last nanosecond of the range still lands in a bucket', async () => {
    const { token, project_id } = await project();
    await write_request(project_id, {
      trace_id: 'last-ns',
      start: nanos(DAY_ONE.to) - 1n,
      cost: 3,
    });

    expect_readers_agree(await request_readers(token, project_id, DAY_ONE), {
      requests: 1,
      cost: 3,
    });
  });
});

describe('where the buckets sit', () => {
  const headers_for = (token: string) => bearer(token);

  const timeseries = (token: string, project_id: string, query: Range & { time_zone?: string }) =>
    api.projects[project_id]!.metrics.timeseries.get({
      $query: query,
      $headers: headers_for(token),
    });

  const starts = (points: readonly { start_at: string }[]): number[] =>
    points.map((point) => Date.parse(point.start_at));

  const strictly_increasing = (values: readonly number[]): boolean =>
    values.every((value, index) => index === 0 || value > values[index - 1]!);

  test('hourly buckets follow the zone, so Kolkata reads on the half hour', async () => {
    const { token, project_id } = await project();
    const range = range_ending('2026-06-02T00:00:00.000Z', DAY_MS);

    const res = await timeseries(token, project_id, { ...range, time_zone: 'Asia/Kolkata' });

    expect(res.data!.bucket_seconds).toBe(3600);
    const minutes = res.data!.points.map((point) => new Date(point.start_at).getUTCMinutes());
    expect(new Set(minutes)).toEqual(new Set([30]));
  });

  test('daily buckets start on the local midnight, before and after a clock change', async () => {
    const { token, project_id } = await project();
    const range = range_ending('2025-11-16T05:00:00.000Z', 30 * DAY_MS);
    await write_request(project_id, {
      trace_id: 'repeated-hour',
      start: nanos('2025-11-02T05:30:00.000Z'),
      cost: 1,
    });

    const res = await timeseries(token, project_id, { ...range, time_zone: 'America/New_York' });

    expect(res.data!.bucket_seconds).toBe(86_400);
    const hours = res.data!.points.map((point) => new Date(point.start_at).getUTCHours());
    expect(hours.slice(0, 2)).toEqual([4, 4]);
    expect(hours.slice(-2)).toEqual([5, 5]);
    expect(strictly_increasing(starts(res.data!.points))).toBe(true);
    expect(sum(res.data!.points, (point) => money(point.total_cost))).toBeCloseTo(1, 9);
  });

  for (const [name, range] of [
    [
      'ends inside the hour that repeats when the clocks go back',
      { from: '2025-11-02T00:00:00-04:00', to: '2025-11-02T01:15:00-05:00' },
    ],
    [
      'crosses the hour that is skipped when the clocks go forward',
      { from: '2025-03-09T00:00:00-05:00', to: '2025-03-09T06:00:00-04:00' },
    ],
  ] as const) {
    test(`a range that ${name} counts every request once`, async () => {
      const { token, project_id } = await project();
      const inside = Date.parse(range.from) + 90 * MINUTE_MS;
      await write_request(project_id, { trace_id: 'early', start: nanos(iso(inside)), cost: 1 });
      await write_request(project_id, {
        trace_id: 'late',
        start: nanos(range.to) - BigInt(10 * MINUTE_MS) * NANOS_PER_MS,
        cost: 2,
      });

      const res = await timeseries(token, project_id, { ...range, time_zone: 'America/New_York' });

      expect(res.status).toBe(200);
      expect(strictly_increasing(starts(res.data!.points))).toBe(true);
      expect(sum(res.data!.points, (point) => point.request_count)).toBe(2);
      expect(sum(res.data!.points, (point) => money(point.total_cost))).toBeCloseTo(3, 9);
    });
  }
});

describe('what the range rejects', () => {
  const VALID: Range = { from: '2026-06-01T00:00:00.000Z', to: '2026-06-02T00:00:00.000Z' };

  const ranged_reads = (token: string, project_id: string, query: Range) => {
    const headers = bearer(token);
    const scoped = api.projects[project_id]!;
    return {
      'metrics/kpis': () => scoped.metrics.kpis.get({ $query: query, $headers: headers }),
      'metrics/timeseries': () =>
        scoped.metrics.timeseries.get({ $query: query, $headers: headers }),
      'metrics/blocks': () => scoped.metrics.blocks.get({ $query: query, $headers: headers }),
      'metrics/distribution': () =>
        scoped.metrics.distribution.get({
          $query: { ...query, metric: 'cost_per_request', buckets: 20 },
          $headers: headers,
        }),
      requests: () =>
        scoped.requests.get({ $query: { ...query, limit: 20, offset: 0 }, $headers: headers }),
      'monitoring/series': () => scoped.monitoring.series.get({ $query: query, $headers: headers }),
      'monitoring/traces': () =>
        scoped.monitoring.traces.get({ $query: { ...query, limit: 20 }, $headers: headers }),
      'monitoring/llm': () =>
        scoped.monitoring.llm.get({ $query: { ...query, limit: 20 }, $headers: headers }),
      'monitoring/logs': () =>
        scoped.monitoring.logs.get({
          $query: { ...query, limit: 20, errors_only: false },
          $headers: headers,
        }),
      'monitoring/errors/summary': () =>
        scoped.monitoring.errors.summary.get({ $query: query, $headers: headers }),
      'resources/overview': () => api.resources.overview.get({ $query: query, $headers: headers }),
    };
  };

  test('every ranged read rejects a range that ends before it starts', async () => {
    const { token, project_id } = await project();
    const reads = ranged_reads(token, project_id, { from: VALID.to, to: VALID.from });

    for (const [name, read] of Object.entries(reads)) {
      const res = await read();
      expect({ name, status: res.status }).toEqual({ name, status: 422 });
    }
  });

  for (const [name, query] of [
    ['a range with no length', { from: VALID.from, to: VALID.from }],
    ['a range missing its end', { from: VALID.from }],
    ['an end with no offset', { from: VALID.from, to: '2026-06-02T00:00:00' }],
    [
      'a start before the year 2000',
      { from: '1999-12-31T00:00:00.000Z', to: '2000-01-02T00:00:00.000Z' },
    ],
    ['an end more than a day ahead', { from: VALID.from, to: iso(Date.now() + 2 * DAY_MS) }],
    [
      'a range longer than a year',
      { from: '2025-01-01T00:00:00.000Z', to: '2026-01-03T00:00:00.000Z' },
    ],
  ] as const) {
    test(`${name} is rejected`, async () => {
      const { token, project_id } = await project();
      const headers = bearer(token);

      const kpis = await api.projects[project_id]!.metrics.kpis.get({
        $query: query as never,
        $headers: headers,
      });
      const series = await api.projects[project_id]!.monitoring.series.get({
        $query: query as never,
        $headers: headers,
      });

      expect(kpis.status).toBe(422);
      expect(series.status).toBe(422);
    });
  }

  test('a bucketed read takes a zone by its IANA name, never as an offset', async () => {
    const { token, project_id } = await project();
    const headers = bearer(token);
    const read = (time_zone: string) =>
      api.projects[project_id]!.metrics.timeseries.get({
        $query: { ...VALID, time_zone },
        $headers: headers,
      });

    expect((await read('America/Sao_Paulo')).status).toBe(200);
    expect((await read('+05:30')).status).toBe(422);
    expect((await read('Mars/Base')).status).toBe(422);
  });
});

describe('what the range derives', () => {
  test('the KPIs carry the run rate: per hour for a day or less, per day beyond', async () => {
    const { token, project_id } = await project();
    const headers = bearer(token);
    const hour = range_ending('2026-06-02T00:00:00.000Z', HOUR_MS);
    const week = range_ending('2026-06-02T00:00:00.000Z', 7 * DAY_MS);
    await write_request(project_id, { trace_id: 'hourly', start: nanos(hour.from), cost: 0.6 });
    await write_request(project_id, { trace_id: 'weekly', start: nanos(week.from), cost: 6.4 });

    const hourly = await api.projects[project_id]!.metrics.kpis.get({
      $query: hour,
      $headers: headers,
    });
    const weekly = await api.projects[project_id]!.metrics.kpis.get({
      $query: week,
      $headers: headers,
    });

    expect(hourly.data!.run_rate_per).toBe('hour');
    expect(money(hourly.data!.run_rate)).toBeCloseTo(0.6, 9);
    expect(weekly.data!.run_rate_per).toBe('day');
    expect(money(weekly.data!.run_rate)).toBeCloseTo(1, 9);
  });

  test('a request is compared against the medians of the range it is read in', async () => {
    const { token, project_id } = await project();
    const headers = bearer(token);
    const day_one: Range = { from: '2026-06-01T00:00:00.000Z', to: '2026-06-02T00:00:00.000Z' };
    const both_days: Range = { from: '2026-06-01T00:00:00.000Z', to: '2026-06-03T00:00:00.000Z' };
    await write_request(project_id, { trace_id: 'cheap', start: nanos(day_one.from), cost: 1 });
    await write_request(project_id, { trace_id: 'dear', start: nanos(day_one.to), cost: 3 });

    const alone = await api.projects[project_id]!.requests[trace_key(project_id, 'cheap')]!.get({
      $query: day_one,
      $headers: headers,
    });
    const together = await api.projects[project_id]!.requests[trace_key(project_id, 'cheap')]!.get({
      $query: both_days,
      $headers: headers,
    });
    const unscoped = await api.projects[project_id]!.requests[trace_key(project_id, 'cheap')]!.get({
      $headers: headers,
    } as never);

    expect(money(alone.data!.median_cost)).toBeCloseTo(1, 9);
    expect(money(together.data!.median_cost)).toBeCloseTo(2, 9);
    expect(unscoped.status).toBe(422);
  });
});
