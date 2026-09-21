import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { db } from '@api/db/client';
import { otelSpans } from '@api/db/schema';
import {
  GEN_AI,
  PROJECT_ID_ATTRIBUTE,
  RUNTIME_ATTRIBUTES,
  STATUS_CODE,
} from '@api/modules/metrics/metrics.contract';

import {
  clear_workflow_generation_mock,
  set_workflow_generation_mock,
} from '../modules/workflows/workflows.generation.testkit';
import { workflows_queue } from '../modules/workflows/workflows.queue';
import { api, setupE2ETests } from './e2e.setup';
import { authenticate, bearer } from './project-test.utils';

setupE2ETests();

const NANOS_PER_MS = 1_000_000n;

// Off-path generation would otherwise run the static analyzer on every project create.
beforeEach(() => {
  set_workflow_generation_mock(async () => ({ status: 'failed', error_message: 'metrics test' }));
});

afterEach(async () => {
  await workflows_queue.idle();
  clear_workflow_generation_mock();
});

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// One frozen reference time: deriving each row from Date.now() at insert time would skew the
// wall-clock latency fixtures by the milliseconds between inserts.
const BASE_MS = Date.now();

const nanos_ago = (ms_ago: number): bigint => BigInt(BASE_MS - Math.round(ms_ago)) * NANOS_PER_MS;

const agent_names = new Map<string, string>();

/** A span's name is its agent's identity, so a replica id is declared with the name it runs under. */
function register_agent_name(agent_id: string, name?: string): void {
  agent_names.set(agent_id, name ?? agent_id);
}

const UNATTRIBUTED_NAME = 'unattributed';

interface SpanFixture {
  span_id: string;
  trace_id: string;
  ms_ago: number;
  execution_time_ms: number;
  input_token_count?: number;
  output_token_count?: number;
  /** Omitted together to write a span that reported no cost at all. */
  token_cost?: string;
  server_cost?: string;
  total_cost?: string;
  errors?: number;
  failed?: boolean;
  agent_id?: string;
  model?: string;
  cache_read_tokens?: number;
  name?: string;
  parent_span_id?: string;
}

async function insert_span(project_id: string, span: SpanFixture): Promise<void> {
  const start = nanos_ago(span.ms_ago);
  const attributes: Record<string, unknown> = { [PROJECT_ID_ATTRIBUTE]: project_id };
  if (span.token_cost !== undefined) {
    attributes[RUNTIME_ATTRIBUTES.TOKEN_COST] = Number(span.token_cost);
  }
  if (span.server_cost !== undefined) {
    attributes[RUNTIME_ATTRIBUTES.SERVER_COST] = Number(span.server_cost);
  }
  if (span.total_cost !== undefined) attributes[GEN_AI.USAGE_COST] = Number(span.total_cost);
  if (span.input_token_count !== undefined) {
    attributes[GEN_AI.INPUT_TOKENS] = span.input_token_count;
  }
  if (span.output_token_count !== undefined) {
    attributes[GEN_AI.OUTPUT_TOKENS] = span.output_token_count;
  }
  if (span.errors !== undefined) attributes[RUNTIME_ATTRIBUTES.ERROR_COUNT] = span.errors;
  if (span.agent_id !== undefined) attributes[GEN_AI.AGENT_ID] = span.agent_id;
  if (span.model !== undefined) attributes[GEN_AI.REQUEST_MODEL] = span.model;
  if (span.cache_read_tokens !== undefined) {
    attributes[GEN_AI.CACHE_READ_INPUT_TOKENS] = span.cache_read_tokens;
  }

  await db.insert(otelSpans).values({
    span_id: span.span_id,
    trace_id: span.trace_id,
    parent_span_id: span.parent_span_id ?? null,
    name:
      span.name ??
      (span.agent_id === undefined
        ? UNATTRIBUTED_NAME
        : (agent_names.get(span.agent_id) ?? span.agent_id)),
    status_code: span.failed === true ? STATUS_CODE.ERROR : STATUS_CODE.UNSET,
    start_time_unix_nano: start,
    end_time_unix_nano: start + BigInt(span.execution_time_ms) * NANOS_PER_MS,
    attributes,
  });
}

async function create_project(email: string): Promise<{ token: string; project_id: string }> {
  const token = await authenticate(email);
  const project = await api.projects.post(
    { name: 'Metrics Project', files: [{ path: 'workflow.py', content: 'def run(): pass\n' }] },
    { headers: bearer(token) }
  );
  expect(project.error).toBeNull();
  return { token, project_id: project.data!.project.id };
}

/**
 * Fixture timeline (per trace: tokens / llm / harness / total cost, wall-clock latency):
 * - kpi-s-recent   (2h ago):  2 spans, 300 tok, 0.000300/0.000030/0.000330, 5000ms
 * - kpi-s-failed   (3d ago):  1 span,   50 tok, 0.000050/0.000005/0.000055, 2000ms
 * - kpi-s-uncosted (10d ago): 2 spans, one reporting no cost at all,        1500ms
 * - kpi-s-old      (50d ago): 1 span,  500 tok, 0.000500/0.000050/0.000550, 4000ms
 */
async function seed_span_fixture(project_id: string): Promise<void> {
  await insert_span(project_id, {
    span_id: 'kpi-b-recent-1',
    trace_id: 'kpi-s-recent',
    ms_ago: 2 * HOUR_MS,
    execution_time_ms: 1000,
    input_token_count: 60,
    output_token_count: 40,
    token_cost: '0.000100',
    server_cost: '0.000010',
    total_cost: '0.000110',
  });
  await insert_span(project_id, {
    span_id: 'kpi-b-recent-2',
    trace_id: 'kpi-s-recent',
    ms_ago: 2 * HOUR_MS - 2000,
    execution_time_ms: 3000,
    input_token_count: 120,
    output_token_count: 80,
    token_cost: '0.000200',
    server_cost: '0.000020',
    total_cost: '0.000220',
    errors: 1,
  });
  await insert_span(project_id, {
    span_id: 'kpi-b-failed-1',
    trace_id: 'kpi-s-failed',
    ms_ago: 3 * DAY_MS,
    execution_time_ms: 2000,
    input_token_count: 40,
    output_token_count: 10,
    token_cost: '0.000050',
    server_cost: '0.000005',
    total_cost: '0.000055',
    errors: 2,
    failed: true,
  });
  await insert_span(project_id, {
    span_id: 'kpi-b-uncosted',
    trace_id: 'kpi-s-uncosted',
    ms_ago: 10 * DAY_MS,
    execution_time_ms: 500,
  });
  await insert_span(project_id, {
    span_id: 'kpi-b-uncosted-child',
    trace_id: 'kpi-s-uncosted',
    ms_ago: 10 * DAY_MS - 1000,
    execution_time_ms: 500,
    input_token_count: 30,
    output_token_count: 20,
    token_cost: '0.000050',
    server_cost: '0.000005',
    total_cost: '0.000055',
  });
  await insert_span(project_id, {
    span_id: 'kpi-b-free-1',
    trace_id: 'kpi-s-free',
    ms_ago: 20 * DAY_MS,
    execution_time_ms: 500,
    input_token_count: 0,
    output_token_count: 0,
  });
  await insert_span(project_id, {
    span_id: 'kpi-b-old-1',
    trace_id: 'kpi-s-old',
    ms_ago: 50 * DAY_MS,
    execution_time_ms: 4000,
    input_token_count: 400,
    output_token_count: 100,
    token_cost: '0.000500',
    server_cost: '0.000050',
    total_cost: '0.000550',
  });
}

let token: string;
let project_id: string;

beforeAll(async () => {
  ({ token, project_id } = await create_project('metrics-owner@cc-forge.test'));
  await seed_span_fixture(project_id);
});

describe('GET /projects/:project_id/metrics/kpis', () => {
  test('every window aggregates exactly the spans and traces inside it', async () => {
    const res = await api.projects[project_id]!.metrics.kpis.get({ $headers: bearer(token) });
    expect(res.error).toBeNull();
    const { windows } = res.data!;

    expect(windows['1d']).toEqual({
      request_count: 1,
      block_count: 2,
      failed_block_count: 0,
      tokens: 300,
      per_block_tokens: 150,
      harness_cost: '0.000030',
      llm_cost: '0.000300',
      total_cost: '0.000330',
      // Only kpi-b-recent-2 retried: it ran twice for one result, so half its 0.000220 is waste.
      recoverable_cost: '0.000110',
      per_block_cost: '0.000165',
      per_block_latency_ms: 2000,
      costed_block_count: 2,
      costed_request_count: 1,
      per_costed_request_cost: '0.000330',
    });

    expect(windows['7d'].request_count).toBe(2);
    expect(windows['7d'].block_count).toBe(3);
    expect(windows['7d'].tokens).toBe(350);
    expect(windows['7d'].per_block_tokens).toBeCloseTo(350 / 3, 6);
    expect(windows['7d'].llm_cost).toBe('0.000350');
    expect(windows['7d'].harness_cost).toBe('0.000035');
    expect(windows['7d'].total_cost).toBe('0.000385');
    expect(windows['7d'].per_block_cost).toBe('0.000128');
    expect(windows['7d'].per_block_latency_ms).toBe(2000);
    // kpi-b-failed-1 failed with errors=2: it is counted once, at its full 0.000055, on top of the
    // 0.000110 retry waste already in the 1d window.
    expect(windows['7d'].failed_block_count).toBe(1);
    expect(windows['7d'].recoverable_cost).toBe('0.000165');

    expect(windows['30d'].request_count).toBe(4);
    expect(windows['30d'].block_count).toBe(6);
    expect(windows['30d'].costed_block_count).toBe(4);
    expect(windows['30d'].costed_request_count).toBe(3);
    expect(windows['30d'].tokens).toBe(400);
    expect(windows['30d'].per_block_tokens).toBeCloseTo(400 / 6, 6);
    expect(windows['30d'].total_cost).toBe('0.000440');
    expect(windows['30d'].per_block_cost).toBe('0.000110');
    // Averaged over the three costed traces (0.000330, 0.000055, 0.000055), not over all four.
    expect(windows['30d'].per_costed_request_cost).toBe('0.000147');
    expect(windows['30d'].per_block_latency_ms).toBe(1250);
    expect(windows['30d'].recoverable_cost).toBe('0.000165');

    expect(windows['1q'].request_count).toBe(5);
    expect(windows['1q'].block_count).toBe(7);
    expect(windows['1q'].costed_block_count).toBe(5);
    expect(windows['1q'].costed_request_count).toBe(4);
    expect(windows['1q'].failed_block_count).toBe(1);
    expect(windows['1q'].tokens).toBe(900);
    expect(windows['1q'].per_block_tokens).toBeCloseTo(900 / 7, 6);
    expect(windows['1q'].harness_cost).toBe('0.000090');
    expect(windows['1q'].llm_cost).toBe('0.000900');
    expect(windows['1q'].total_cost).toBe('0.000990');
    // The whole 0.000990 spread over the four costed traces, not over all five.
    expect(windows['1q'].per_costed_request_cost).toBe('0.000248');
    expect(windows['1q'].recoverable_cost).toBe('0.000165');
    expect(windows['1q'].per_block_latency_ms).toBeCloseTo(11500 / 7, 6);
  });

  test('a project with no telemetry spans returns zeroed windows', async () => {
    const empty = await create_project('metrics-empty@cc-forge.test');
    const res = await api.projects[empty.project_id]!.metrics.kpis.get({
      $headers: bearer(empty.token),
    });
    expect(res.error).toBeNull();
    expect(res.data!.windows['1q']).toEqual({
      request_count: 0,
      block_count: 0,
      failed_block_count: 0,
      tokens: 0,
      per_block_tokens: null,
      harness_cost: '0.000000',
      llm_cost: '0.000000',
      total_cost: '0.000000',
      recoverable_cost: '0.000000',
      per_block_cost: null,
      per_block_latency_ms: null,
      costed_block_count: 0,
      costed_request_count: 0,
      per_costed_request_cost: null,
    });
  });
});

describe('GET /projects/:project_id/metrics/distribution', () => {
  test('latency: every request in the window, wall-clock ms, exact stats', async () => {
    const res = await api.projects[project_id]!.metrics.distribution.get({
      $headers: bearer(token),
      $query: { metric: 'latency', time_window: '30d', buckets: 2 },
    });
    expect(res.error).toBeNull();
    const dist = res.data!;

    // Every stored span has ended, so all four 30-day requests have a wall clock:
    // s-free 500ms, s-uncosted 1500ms, s-failed 2000ms, s-recent 5000ms.
    const latencies = [500, 1500, 2000, 5000];
    const mean = latencies.reduce((sum, value) => sum + value, 0) / latencies.length;

    expect(dist.request_count).toBe(4);
    expect(dist.mean).toBeCloseTo(mean, 6);
    expect(dist.std).toBeCloseTo(
      Math.sqrt(latencies.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (latencies.length - 1)),
      6
    );
    expect(dist.min).toBe(500);
    expect(dist.max).toBe(5000);
    expect(dist.p50).toBe(1750);
    expect(dist.buckets).toEqual([
      { lower: 500, upper: 2750, count: 3 },
      { lower: 2750, upper: 5000, count: 1 },
    ]);
  });

  test('tokens_per_request over the full quarter includes every request', async () => {
    const res = await api.projects[project_id]!.metrics.distribution.get({
      $headers: bearer(token),
      $query: { metric: 'tokens_per_request', time_window: '1q', buckets: 3 },
    });
    expect(res.error).toBeNull();
    const dist = res.data!;

    // 300 (recent), 50 (failed), 50 (uncosted), 0 (free), 500 (old): missing token attributes
    // contribute zero to the trace total, so the free trace bins at 0 rather than dropping out.
    expect(dist.request_count).toBe(5);
    expect(dist.mean).toBe(180);
    expect(dist.min).toBe(0);
    expect(dist.max).toBe(500);
    expect(dist.buckets.map((bucket) => bucket.count)).toEqual([3, 1, 1]);
    expect(dist.buckets[0]).toEqual({ lower: 0, upper: 500 / 3, count: 3 });
  });

  test('cost_per_request keeps window scoping (1d sees only the recent request)', async () => {
    const res = await api.projects[project_id]!.metrics.distribution.get({
      $headers: bearer(token),
      $query: { metric: 'cost_per_request', time_window: '1d', buckets: 5 },
    });
    expect(res.error).toBeNull();
    const dist = res.data!;

    // A single value collapses the histogram to one bucket and has no sample deviation.
    expect(dist.request_count).toBe(1);
    expect(dist.mean).toBeCloseTo(0.00033, 10);
    expect(dist.std).toBeNull();
    expect(dist.buckets).toEqual([{ lower: 0.00033, upper: 0.00033, count: 1 }]);
  });

  test('a project with no telemetry spans returns an empty distribution', async () => {
    const empty = await create_project('metrics-empty-dist@cc-forge.test');
    const res = await api.projects[empty.project_id]!.metrics.distribution.get({
      $headers: bearer(empty.token),
      $query: { metric: 'latency', time_window: '1q', buckets: 10 },
    });
    expect(res.error).toBeNull();
    expect(res.data).toEqual({
      project_id: empty.project_id,
      metric: 'latency',
      time_window: '1q',
      request_count: 0,
      mean: null,
      std: null,
      min: null,
      max: null,
      p50: null,
      p95: null,
      p99: null,
      buckets: [],
    });
  });

  test('an unknown metric is rejected by validation (422)', async () => {
    const res = await api.projects[project_id]!.metrics.distribution.get({
      $headers: bearer(token),
      // @ts-expect-error deliberately invalid metric
      $query: { metric: 'nope', time_window: '1d', buckets: 5 },
    });
    expect(res.error?.status as number).toBe(422);
  });
});

describe('GET /projects/:project_id/metrics/timeseries', () => {
  let series_token: string;
  let series_project: string;
  let calendar_token: string;
  let calendar_project: string;

  // The grid snaps to whole hours, so the shared fixture's blocks (exactly 2h ago) sit on an edge
  // and split unpredictably. These sit mid-bucket at 2.5h and 5.5h, so each one stays inside a
  // single bucket however long the fixture takes to reach the query.
  beforeAll(async () => {
    ({ token: series_token, project_id: series_project } = await create_project(
      'metrics-series@cc-forge.test'
    ));

    await insert_span(series_project, {
      span_id: 'ser-b-1',
      trace_id: 'ser-recent',
      ms_ago: 2.5 * HOUR_MS,
      execution_time_ms: 1000,
      input_token_count: 60,
      output_token_count: 40,
      token_cost: '0.000100',
      server_cost: '0.000010',
      total_cost: '0.000110',
    });
    await insert_span(series_project, {
      span_id: 'ser-b-2',
      trace_id: 'ser-recent',
      ms_ago: 2.5 * HOUR_MS - 2000,
      execution_time_ms: 3000,
      input_token_count: 120,
      output_token_count: 80,
      token_cost: '0.000200',
      server_cost: '0.000020',
      total_cost: '0.000220',
    });
    await insert_span(series_project, {
      span_id: 'ser-b-3',
      trace_id: 'ser-older',
      ms_ago: 5.5 * HOUR_MS,
      execution_time_ms: 2000,
      input_token_count: 40,
      output_token_count: 10,
      token_cost: '0.000050',
      server_cost: '0.000005',
      total_cost: '0.000055',
    });

    // Two calendar days apart on purpose: one block inside today, one older than any day-grid the
    // week window can start on.
    ({ token: calendar_token, project_id: calendar_project } = await create_project(
      'metrics-calendar@cc-forge.test'
    ));
    await insert_span(calendar_project, {
      span_id: 'cal-b-today',
      trace_id: 'cal-today',
      ms_ago: 0,
      execution_time_ms: 1000,
      input_token_count: 60,
      output_token_count: 40,
      token_cost: '0.000100',
      server_cost: '0.000010',
      total_cost: '0.000110',
    });
    await insert_span(calendar_project, {
      span_id: 'cal-b-old',
      trace_id: 'cal-old',
      ms_ago: 8 * DAY_MS,
      execution_time_ms: 1000,
      input_token_count: 10,
      output_token_count: 10,
      token_cost: '0.000050',
      server_cost: '0.000005',
      total_cost: '0.000055',
    });
  });

  test('a day is 24 hourly buckets, each block in the bucket its start falls in', async () => {
    const res = await api.projects[series_project]!.metrics.timeseries.get({
      $headers: bearer(series_token),
      $query: { time_window: '1d' },
    });
    expect(res.error).toBeNull();
    const series = res.data!;

    expect(series.time_window).toBe('1d');
    expect(series.bucket_seconds).toBe(3600);
    expect(series.points).toHaveLength(24);

    for (const point of series.points) {
      expect(new Date(point.start_at).toISOString()).toMatch(/T\d{2}:00:00\.000Z$/);
    }

    const busy = series.points
      .map((point, index) => ({ index, point }))
      .filter(({ point }) => point.block_count > 0);
    // The two traces ran three hours apart, so they fall three hourly buckets apart.
    expect(busy).toHaveLength(2);
    expect(busy[1]!.index - busy[0]!.index).toBe(3);

    const covers = (start_at: string, ms_ago: number): boolean => {
      const start = Date.parse(start_at);
      const started_at = BASE_MS - ms_ago;
      return started_at >= start && started_at < start + series.bucket_seconds * 1000;
    };
    expect(covers(busy[0]!.point.start_at, 5.5 * HOUR_MS)).toBe(true);
    expect(covers(busy[1]!.point.start_at, 2.5 * HOUR_MS)).toBe(true);

    expect(busy[0]!.point).toMatchObject({
      request_count: 1,
      block_count: 1,
      tokens: 50,
      llm_cost: '0.000050',
      harness_cost: '0.000005',
      total_cost: '0.000055',
    });
    expect(busy[1]!.point).toMatchObject({
      request_count: 1,
      block_count: 2,
      tokens: 300,
      llm_cost: '0.000300',
      harness_cost: '0.000030',
      total_cost: '0.000330',
    });

    const empty = series.points.filter((point) => point.block_count === 0);
    expect(empty).toHaveLength(22);
    expect(empty[0]).toMatchObject({
      request_count: 0,
      tokens: 0,
      llm_cost: '0.000000',
      harness_cost: '0.000000',
      total_cost: '0.000000',
    });

    const starts = series.points.map((point) => Date.parse(point.start_at));
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(starts[1]! - starts[0]!).toBe(3600 * 1000);
  });

  test("the longer windows bucket on the reader's local midnight, the current day last", async () => {
    const grids = [
      { time_window: '7d', buckets: 7, bucket_seconds: 86_400 },
      { time_window: '30d', buckets: 30, bucket_seconds: 86_400 },
      { time_window: '1q', buckets: 30, bucket_seconds: 3 * 86_400 },
    ] as const;
    const time_zone = 'Asia/Shanghai';
    const local_hour = new Intl.DateTimeFormat('en-US', {
      timeZone: time_zone,
      hour: 'numeric',
      hourCycle: 'h23',
    });

    for (const grid of grids) {
      const query = { time_window: grid.time_window, buckets: grid.buckets, time_zone } as const;
      const res = await api.projects[calendar_project]!.metrics.timeseries.get({
        $headers: bearer(calendar_token),
        $query: query,
      });
      expect(res.error).toBeNull();
      const series = res.data!;
      expect(series.bucket_seconds).toBe(grid.bucket_seconds);
      expect(series.points).toHaveLength(grid.buckets);

      const starts = series.points.map((point) => new Date(point.start_at).getTime());
      for (const start of starts) {
        expect(local_hour.format(start)).toBe('00');
      }
      const step = grid.bucket_seconds * 1000;
      expect(starts).toEqual(starts.map((_start, index) => starts[0]! + index * step));

      // The newest bucket is the one now falls inside — today so far, not a full period.
      const last = starts.at(-1)!;
      expect(Date.now()).toBeGreaterThanOrEqual(last);
      expect(Date.now()).toBeLessThan(last + step);
    }
  });

  test('a block from today lands in the last bucket, one before the grid start is dropped', async () => {
    const [week, month] = await Promise.all([
      api.projects[calendar_project]!.metrics.timeseries.get({
        $headers: bearer(calendar_token),
        $query: { time_window: '7d', buckets: 7 },
      }),
      api.projects[calendar_project]!.metrics.timeseries.get({
        $headers: bearer(calendar_token),
        $query: { time_window: '30d', buckets: 30 },
      }),
    ]);
    expect(week.error).toBeNull();
    expect(month.error).toBeNull();

    const week_points = week.data!.points;
    expect(week_points.at(-1)).toMatchObject({
      request_count: 1,
      block_count: 1,
      total_cost: '0.000110',
    });
    // Seven midnight-aligned days reach back six days, so the 8-day-old block is outside them.
    expect(week_points.reduce((sum, point) => sum + point.block_count, 0)).toBe(1);

    const month_points = month.data!.points;
    expect(month_points.reduce((sum, point) => sum + point.block_count, 0)).toBe(2);
    expect(month_points.at(-1)!.block_count).toBe(1);
    // Thirty daily buckets ending with today: eight days back is the ninth from the end.
    expect(month_points.findIndex((point) => point.block_count > 0)).toBe(month_points.length - 9);
  });

  test('the quarter sums back to the 1q KPI window', async () => {
    const [series, kpis] = await Promise.all([
      api.projects[project_id]!.metrics.timeseries.get({
        $headers: bearer(token),
        $query: { time_window: '1q', buckets: 90 },
      }),
      api.projects[project_id]!.metrics.kpis.get({ $headers: bearer(token) }),
    ]);
    expect(series.error).toBeNull();
    expect(kpis.error).toBeNull();

    const points = series.data!.points;
    expect(points).toHaveLength(90);
    expect(series.data!.bucket_seconds).toBe(86400);

    const time_window = kpis.data!.windows['1q'];
    expect(points.reduce((sum, point) => sum + point.block_count, 0)).toBe(time_window.block_count);
    expect(points.reduce((sum, point) => sum + point.tokens, 0)).toBe(time_window.tokens);
    const total = points.reduce((sum, point) => sum + Number(point.total_cost), 0);
    expect(total).toBeCloseTo(Number(time_window.total_cost), 10);
  });

  test('buckets default per time_window: 30 outside a day', async () => {
    const res = await api.projects[project_id]!.metrics.timeseries.get({
      $headers: bearer(token),
      $query: { time_window: '7d' },
    });
    expect(res.error).toBeNull();
    expect(res.data!.points).toHaveLength(30);
    expect(res.data!.bucket_seconds).toBe((7 * 24 * 3600) / 30);
  });

  test('a project with no telemetry spans still emits every bucket, all zeroed', async () => {
    const empty = await create_project('metrics-empty-series@cc-forge.test');
    const res = await api.projects[empty.project_id]!.metrics.timeseries.get({
      $headers: bearer(empty.token),
      $query: { time_window: '30d', buckets: 5 },
    });
    expect(res.error).toBeNull();
    expect(res.data!.points).toHaveLength(5);
    expect(res.data!.points.every((point) => point.total_cost === '0.000000')).toBe(true);
    expect(res.data!.points.every((point) => point.request_count === 0)).toBe(true);
  });

  test('a bucket count above the cap is rejected by validation (422)', async () => {
    const res = await api.projects[project_id]!.metrics.timeseries.get({
      $headers: bearer(token),
      $query: { time_window: '30d', buckets: 121 },
    });
    expect(res.error?.status as number).toBe(422);
  });

  test('an invalid time zone is rejected by validation (422)', async () => {
    const query = { time_window: '30d', time_zone: 'Mars/Olympus_Mons' } as const;
    const res = await api.projects[project_id]!.metrics.timeseries.get({
      $headers: bearer(token),
      $query: query,
    });
    expect(res.error?.status as number).toBe(422);
  });

  test('a zone ICU accepts but Postgres rejects is remapped to 422, not a 500', async () => {
    const query = { time_window: '30d', time_zone: '-0800' } as const;
    const res = await api.projects[project_id]!.metrics.timeseries.get({
      $headers: bearer(token),
      $query: query,
    });
    expect(res.error?.status as number).toBe(422);
    expect((res.error?.value as { error?: string })?.error).toBe('metrics.invalid_time_zone');
  });

  test('an unknown window is rejected by validation (422)', async () => {
    const res = await api.projects[project_id]!.metrics.timeseries.get({
      $headers: bearer(token),
      // @ts-expect-error deliberately invalid window
      $query: { time_window: '2y' },
    });
    expect(res.error?.status as number).toBe(422);
  });

  test('a request without a token is rejected with 401', async () => {
    const res = await api.projects[project_id]!.metrics.timeseries.get({
      $query: { time_window: '30d' },
    });
    expect(res.error?.status as number).toBe(401);
  });

  test("another company reads the project's timeseries", async () => {
    const other_company = await authenticate('metrics-series-intruder@cc-forge.test');
    const res = await api.projects[project_id]!.metrics.timeseries.get({
      $headers: bearer(other_company),
      $query: { time_window: '30d' },
    });
    expect(res.error).toBeNull();
    expect(res.data!.points.length).toBeGreaterThan(0);
  });
});

describe('GET /projects/:project_id/metrics/blocks', () => {
  let blocks_token: string;
  let blocks_project: string;

  beforeAll(async () => {
    ({ token: blocks_token, project_id: blocks_project } = await create_project(
      'metrics-blocks@cc-forge.test'
    ));
    register_agent_name('blk-agent-model');
    register_agent_name('blk-agent-harness');

    await insert_span(blocks_project, {
      span_id: 'blk-b-model-1',
      trace_id: 'blk-session',
      ms_ago: 2 * HOUR_MS,
      execution_time_ms: 1000,
      input_token_count: 60,
      output_token_count: 40,
      token_cost: '0.000100',
      server_cost: '0.000010',
      total_cost: '0.000110',
      agent_id: 'blk-agent-model',
      model: 'claude-opus-4',
      cache_read_tokens: 60,
    });
    await insert_span(blocks_project, {
      span_id: 'blk-b-model-2',
      trace_id: 'blk-session',
      ms_ago: 2 * HOUR_MS - 2000,
      execution_time_ms: 3000,
      input_token_count: 120,
      output_token_count: 80,
      token_cost: '0.000200',
      server_cost: '0.000020',
      total_cost: '0.000220',
      errors: 1,
      agent_id: 'blk-agent-model',
      model: 'claude-opus-4',
      cache_read_tokens: 1080,
    });
    // Failed *and* retried three times: recoverable_cost must charge it once, in full.
    await insert_span(blocks_project, {
      span_id: 'blk-b-harness-1',
      trace_id: 'blk-session',
      // Outside 1d, inside 30d: the only span the narrower window drops.
      ms_ago: 3 * DAY_MS,
      execution_time_ms: 2000,
      input_token_count: 0,
      output_token_count: 0,
      token_cost: '0.000000',
      server_cost: '0.000500',
      total_cost: '0.000500',
      errors: 3,
      failed: true,
      agent_id: 'blk-agent-harness',
    });
  });

  test('groups per agent, orders by cost desc, and derives kind from the model', async () => {
    const res = await api.projects[blocks_project]!.metrics.blocks.get({
      $headers: bearer(blocks_token),
      $query: { time_window: '30d' },
    });
    expect(res.error).toBeNull();
    const { total_cost, blocks } = res.data!;

    expect(total_cost).toBe('0.000830');
    expect(blocks.map((block) => block.agent_id)).toEqual(['blk-agent-harness', 'blk-agent-model']);

    const [harness, model] = blocks;
    expect(harness).toMatchObject({
      model: null,
      // No display name reported for this agent, so the label falls back to its id.
      label: 'blk-agent-harness',
      kind: 'harness',
      cost: '0.000500',
      llm_cost: '0.000000',
      harness_cost: '0.000500',
      // Failed once, not failed-plus-retried twice: 0.000500, not 0.000500 + 0.000375.
      recoverable_cost: '0.000500',
      block_count: 1,
      token_count: 0,
      retry_rate: 1,
      failed_rate: 1,
      cache_hit_ratio: null,
    });
    expect(harness!.p95_latency_ms).toBeCloseTo(2000, 6);

    expect(model).toMatchObject({
      model: 'claude-opus-4',
      label: 'blk-agent-model',
      kind: 'model',
      cost: '0.000330',
      llm_cost: '0.000300',
      harness_cost: '0.000030',
      recoverable_cost: '0.000110',
      block_count: 2,
      token_count: 300,
      retry_rate: 0.5,
      failed_rate: 0,
    });
    // percentile_cont interpolates between the 1000ms and 3000ms blocks.
    expect(model!.p95_latency_ms).toBeCloseTo(2900, 6);
    expect(model!.cache_hit_ratio).toBeCloseTo(0.7, 10);
  });

  test('the window scopes the breakdown (1d drops the older harness span)', async () => {
    const res = await api.projects[blocks_project]!.metrics.blocks.get({
      $headers: bearer(blocks_token),
      $query: { time_window: '1d' },
    });
    expect(res.error).toBeNull();
    expect(res.data!.blocks.map((block) => block.label)).toEqual(['blk-agent-model']);
    expect(res.data!.total_cost).toBe('0.000330');
  });

  test('a project with no telemetry spans returns no blocks and zero cost', async () => {
    const empty = await create_project('metrics-empty-blocks@cc-forge.test');
    const res = await api.projects[empty.project_id]!.metrics.blocks.get({
      $headers: bearer(empty.token),
      $query: { time_window: '30d' },
    });
    expect(res.error).toBeNull();
    expect(res.data).toEqual({
      project_id: empty.project_id,
      time_window: '30d',
      total_cost: '0.000000',
      blocks: [],
    });
  });

  test('spans reporting no agent id are addressed by the name they ran under', async () => {
    const res = await api.projects[project_id]!.metrics.blocks.get({
      $headers: bearer(token),
      $query: { time_window: '1q' },
    });
    expect(res.error).toBeNull();
    expect(res.data!.blocks).toHaveLength(1);
    expect(res.data!.blocks[0]).toMatchObject({
      // The name stands in as the address when the store reports no id.
      agent_id: 'unattributed',
      model: null,
      label: 'unattributed',
      kind: 'harness',
      block_count: 7,
      cost: '0.000990',
      recoverable_cost: '0.000165',
    });
  });

  test('an unknown window is rejected by validation (422)', async () => {
    const res = await api.projects[blocks_project]!.metrics.blocks.get({
      $headers: bearer(blocks_token),
      // @ts-expect-error deliberately invalid window
      $query: { time_window: 'forever' },
    });
    expect(res.error?.status as number).toBe(422);
  });

  test('a request without a token is rejected with 401', async () => {
    const res = await api.projects[blocks_project]!.metrics.blocks.get({
      $query: { time_window: '30d' },
    });
    expect(res.error?.status as number).toBe(401);
  });

  test("another company reads the project's blocks", async () => {
    const other_company = await authenticate('metrics-blocks-intruder@cc-forge.test');
    const res = await api.projects[blocks_project]!.metrics.blocks.get({
      $headers: bearer(other_company),
      $query: { time_window: '30d' },
    });
    expect(res.error).toBeNull();
    expect(res.data!.blocks.length).toBeGreaterThan(0);
  });
});

describe('GET /projects/:project_id/metrics/agents/:agent_id', () => {
  let details_token: string;
  let details_project: string;

  beforeAll(async () => {
    ({ token: details_token, project_id: details_project } = await create_project(
      'metrics-agent-details@cc-forge.test'
    ));

    register_agent_name('detail-agent', 'Drawer Agent');
    register_agent_name('detail-other');
    register_agent_name('detail-old-agent');

    await insert_span(details_project, {
      span_id: 'detail-agent-a',
      trace_id: 'detail-s1',
      ms_ago: 2 * HOUR_MS,
      execution_time_ms: 1000,
      input_token_count: 60,
      output_token_count: 40,
      token_cost: '0.000300',
      server_cost: '0.000100',
      total_cost: '0.000400',
      agent_id: 'detail-agent',
      model: 'claude-haiku-4',
      cache_read_tokens: 60,
    });
    await insert_span(details_project, {
      span_id: 'detail-agent-b',
      trace_id: 'detail-s1',
      ms_ago: 2 * HOUR_MS - 2000,
      execution_time_ms: 2000,
      input_token_count: 30,
      output_token_count: 20,
      token_cost: '0.000100',
      server_cost: '0.000000',
      total_cost: '0.000100',
      errors: 1,
      agent_id: 'detail-agent',
      model: 'claude-sonnet-4',
      cache_read_tokens: 270,
    });
    await insert_span(details_project, {
      span_id: 'detail-agent-c',
      trace_id: 'detail-s2',
      ms_ago: 3 * HOUR_MS,
      execution_time_ms: 3000,
      input_token_count: 150,
      output_token_count: 50,
      token_cost: '0.001000',
      server_cost: '0.000500',
      total_cost: '0.001500',
      errors: 2,
      failed: true,
      agent_id: 'detail-agent',
      model: 'claude-opus-4',
    });
    await insert_span(details_project, {
      span_id: 'detail-other-a',
      trace_id: 'detail-s3',
      ms_ago: 4 * HOUR_MS,
      execution_time_ms: 500,
      input_token_count: 0,
      output_token_count: 0,
      token_cost: '0.000000',
      server_cost: '0.001000',
      total_cost: '0.001000',
      agent_id: 'detail-other',
    });
    await insert_span(details_project, {
      span_id: 'detail-old-a',
      trace_id: 'detail-old',
      ms_ago: 40 * DAY_MS,
      execution_time_ms: 4000,
      input_token_count: 900,
      output_token_count: 100,
      token_cost: '0.008000',
      server_cost: '0.001000',
      total_cost: '0.009000',
      agent_id: 'detail-old-agent',
      model: 'claude-opus-4',
    });
  });

  test('returns one 30-day agent aggregate across models and its request-cost histogram', async () => {
    const res = await api.projects[details_project]!.metrics.agents['detail-agent']!.get({
      $query: {},
      $headers: bearer(details_token),
    });
    expect(res.error).toBeNull();
    const details = res.data!;

    expect(details).toMatchObject({
      project_id: details_project,
      agent_id: 'detail-agent',
      label: 'Drawer Agent',
      time_window: '30d',
      project: {
        // A request is its spans, so the three in-window traces count and detail-old does not.
        request_count: 3,
        total_cost: '0.003000',
      },
      agent: {
        request_count: 2,
        block_count: 3,
        token_count: 350,
        cost: '0.002000',
        llm_cost: '0.001400',
        harness_cost: '0.000600',
        recoverable_cost: '0.001550',
      },
    });
    expect(details.agent.retry_rate).toBeCloseTo(2 / 3, 10);
    expect(details.agent.failed_rate).toBeCloseTo(1 / 3, 10);
    expect(details.agent.p95_latency_ms).toBeCloseTo(2900, 6);
    expect(details.agent.cache_hit_ratio).toBeCloseTo(0.7, 10);

    const distribution = details.cost_per_request;
    expect(distribution.request_count).toBe(2);
    expect(distribution.mean).toBeCloseTo(0.001, 10);
    expect(distribution.std).toBeCloseTo(Math.sqrt(0.0005 ** 2 + 0.0005 ** 2), 10);
    expect(distribution.min).toBeCloseTo(0.0005, 10);
    expect(distribution.max).toBeCloseTo(0.0015, 10);
    expect(distribution.p50).toBeCloseTo(0.001, 10);
    expect(distribution.p95).toBeCloseTo(0.00145, 10);
    expect(distribution.p99).toBeCloseTo(0.00149, 10);
    expect(distribution.buckets).toHaveLength(12);
    expect(distribution.buckets.map((bucket) => bucket.count)).toEqual([
      1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
    ]);
  });

  test('the same request carries a 30-day cost series that sums to the agent total', async () => {
    const res = await api.projects[details_project]!.metrics.agents['detail-agent']!.get({
      $query: { time_zone: 'UTC' },
      $headers: bearer(details_token),
    });
    expect(res.error).toBeNull();
    const { timeseries, agent } = res.data!;

    // One bucket per calendar day, zero-filled, so a quiet day is a zero rather than a hole.
    expect(timeseries.points).toHaveLength(30);
    expect(timeseries.bucket_seconds).toBeCloseTo(86_400, 6);

    const summed = timeseries.points.reduce((total, point) => total + Number(point.total_cost), 0);
    expect(summed).toBeCloseTo(Number(agent.cost), 10);
    expect(timeseries.points.reduce((total, point) => total + point.block_count, 0)).toBe(
      agent.block_count
    );

    // The window ends on the next day boundary, so the newest bucket is today and every start is
    // ordered and distinct.
    const starts = timeseries.points.map((point) => Date.parse(point.start_at));
    expect(starts).toEqual([...starts].sort((left, right) => left - right));
    expect(new Set(starts).size).toBe(30);
  });

  test('an invalid time zone is rejected by validation (422)', async () => {
    const res = await api.projects[details_project]!.metrics.agents['detail-agent']!.get({
      $query: { time_zone: 'Mars/Olympus_Mons' },
      $headers: bearer(details_token),
    });
    expect(res.error?.status as number).toBe(422);
  });

  test('a zone ICU accepts but Postgres rejects is remapped to 422, not a 500', async () => {
    const res = await api.projects[details_project]!.metrics.agents['detail-agent']!.get({
      $query: { time_zone: '-0800' },
      $headers: bearer(details_token),
    });
    expect(res.error?.status as number).toBe(422);
    expect((res.error?.value as { error?: string })?.error).toBe('metrics.invalid_time_zone');
  });

  test('the same request carries the token and latency distributions for the agent', async () => {
    const res = await api.projects[details_project]!.metrics.agents['detail-agent']!.get({
      $query: {},
      $headers: bearer(details_token),
    });
    expect(res.error).toBeNull();
    const { tokens_per_request, latency } = res.data!;

    // detail-s1 rolls up the agent's two blocks (100 + 50); detail-s2 is the single 200-token one.
    expect(tokens_per_request.request_count).toBe(2);
    expect(tokens_per_request.mean).toBe(175);
    expect(tokens_per_request.std).toBeCloseTo(Math.sqrt(25 ** 2 + 25 ** 2), 10);
    expect(tokens_per_request.min).toBe(150);
    expect(tokens_per_request.max).toBe(200);
    expect(tokens_per_request.p50).toBe(175);
    expect(tokens_per_request.p95).toBeCloseTo(197.5, 10);
    expect(tokens_per_request.p99).toBeCloseTo(199.5, 10);
    expect(tokens_per_request.buckets).toHaveLength(12);
    expect(tokens_per_request.buckets.map((bucket) => bucket.count)).toEqual([
      1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
    ]);
    expect(tokens_per_request.buckets[0]!.lower).toBe(150);
    expect(tokens_per_request.buckets.at(-1)!.upper).toBe(200);

    // Wall clock across the agent's own blocks: detail-s1 spans 4000ms (the second block starts
    // 2000ms in and runs 2000ms), detail-s2 is its 3000ms block alone.
    expect(latency.request_count).toBe(2);
    expect(latency.mean).toBe(3500);
    expect(latency.std).toBeCloseTo(Math.sqrt(500 ** 2 + 500 ** 2), 6);
    expect(latency.min).toBe(3000);
    expect(latency.max).toBe(4000);
    expect(latency.p50).toBe(3500);
    expect(latency.p95).toBeCloseTo(3950, 6);
    expect(latency.buckets).toHaveLength(12);
    expect(latency.buckets.map((bucket) => bucket.count)).toEqual([
      1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
    ]);
  });

  test('all three distributions cover every request the agent ran', async () => {
    const partial = await create_project('metrics-agent-partial@cc-forge.test');
    register_agent_name('partial-agent');

    await insert_span(partial.project_id, {
      span_id: 'partial-block-quick',
      trace_id: 'partial-quick',
      ms_ago: 2 * HOUR_MS,
      execution_time_ms: 1500,
      input_token_count: 10,
      output_token_count: 10,
      token_cost: '0.000100',
      server_cost: '0.000000',
      total_cost: '0.000100',
      agent_id: 'partial-agent',
      model: 'claude-haiku-4',
    });
    await insert_span(partial.project_id, {
      span_id: 'partial-block-slow',
      trace_id: 'partial-slow',
      ms_ago: 3 * HOUR_MS,
      execution_time_ms: 4000,
      input_token_count: 20,
      output_token_count: 10,
      token_cost: '0.000200',
      server_cost: '0.000000',
      total_cost: '0.000200',
      agent_id: 'partial-agent',
      model: 'claude-haiku-4',
    });

    const res = await api.projects[partial.project_id]!.metrics.agents['partial-agent']!.get({
      $query: {},
      $headers: bearer(partial.token),
    });
    expect(res.error).toBeNull();
    const details = res.data!;

    expect(details.cost_per_request.request_count).toBe(2);
    expect(details.tokens_per_request.request_count).toBe(2);
    expect(details.tokens_per_request.min).toBe(20);
    expect(details.tokens_per_request.max).toBe(30);

    // Every stored span has ended, so latency covers the same two requests the others do.
    expect(details.latency.request_count).toBe(2);
    expect(details.latency.mean).toBe(2750);
    expect(details.latency.min).toBe(1500);
    expect(details.latency.max).toBe(4000);
    expect(details.latency.std).toBeCloseTo(Math.sqrt(1250 ** 2 + 1250 ** 2), 6);
    expect(details.latency.buckets).toHaveLength(12);
    expect(details.latency.buckets.map((bucket) => bucket.count)).toEqual([
      1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
    ]);
  });

  test('an agent with no execution in the last 30 days gets 404', async () => {
    const res = await api.projects[details_project]!.metrics.agents['detail-old-agent']!.get({
      $query: {},
      $headers: bearer(details_token),
    });
    expect(res.error?.status as number).toBe(404);
    expect((res.error?.value as { error?: string })?.error).toBe('metrics.agent_not_found');
  });

  test('a request without a token is rejected with 401', async () => {
    const res = await api.projects[details_project]!.metrics.agents['detail-agent']!.get({
      $query: {},
    });
    expect(res.error?.status as number).toBe(401);
  });

  test("another company reads the agent's metrics", async () => {
    const other_company = await authenticate('metrics-agent-details-intruder@cc-forge.test');
    const res = await api.projects[details_project]!.metrics.agents['detail-agent']!.get({
      $query: {},
      $headers: bearer(other_company),
    });
    expect(res.error).toBeNull();
    expect(res.data!.agent.block_count).toBeGreaterThan(0);
  });
});

/**
 * Two requests: the top-level agents each begins with, and the tools those agents called.
 *
 *   flow-s1                        flow-s2
 *     ├─ flow-a      planner         └─ flow-b2     writer
 *     └─ flow-b      writer               └─ flow-t3   search
 *          ├─ flow-t1   search
 *          │    └─ flow-t1a  fetch
 *          └─ flow-t2   search (failed)
 */
describe('GET /projects/:project_id/metrics/flow', () => {
  let flow_token: string;
  let flow_project: string;

  beforeAll(async () => {
    ({ token: flow_token, project_id: flow_project } = await create_project(
      'metrics-flow@cc-forge.test'
    ));
    register_agent_name('flow-planner');
    // Only the writer carries a display name, so the same fixture proves both the name path and
    // the id fallback for agents the runtime never named.
    register_agent_name('flow-writer', 'Report Writer');
    register_agent_name('flow-search');
    register_agent_name('flow-fetch');

    await insert_span(flow_project, {
      span_id: 'flow-a',
      trace_id: 'flow-s1',
      ms_ago: 2 * HOUR_MS,
      execution_time_ms: 1000,
      input_token_count: 180,
      output_token_count: 120,
      token_cost: '0.000300',
      server_cost: '0.000030',
      total_cost: '0.000330',
      agent_id: 'flow-planner',
      model: 'claude-opus-4',
      cache_read_tokens: 180,
    });
    await insert_span(flow_project, {
      span_id: 'flow-b',
      trace_id: 'flow-s1',
      ms_ago: 2 * HOUR_MS,
      execution_time_ms: 3000,
      input_token_count: 240,
      output_token_count: 160,
      token_cost: '0.000400',
      server_cost: '0.000040',
      total_cost: '0.000440',
      errors: 1,
      agent_id: 'flow-writer',
      model: 'claude-opus-4',
    });
    await insert_span(flow_project, {
      span_id: 'flow-t1',
      trace_id: 'flow-s1',
      ms_ago: 2 * HOUR_MS - 1000,
      execution_time_ms: 500,
      input_token_count: 30,
      output_token_count: 20,
      token_cost: '0.000050',
      server_cost: '0.000005',
      total_cost: '0.000055',
      agent_id: 'flow-search',
      parent_span_id: 'flow-b',
    });
    await insert_span(flow_project, {
      span_id: 'flow-t2',
      trace_id: 'flow-s1',
      ms_ago: 2 * HOUR_MS - 2000,
      execution_time_ms: 700,
      input_token_count: 30,
      output_token_count: 20,
      token_cost: '0.000050',
      server_cost: '0.000005',
      total_cost: '0.000055',
      failed: true,
      agent_id: 'flow-search',
      parent_span_id: 'flow-b',
    });
    // A tool calling a tool: two levels below the span that begins the trace, so depth 3.
    await insert_span(flow_project, {
      span_id: 'flow-t1a',
      trace_id: 'flow-s1',
      ms_ago: 2 * HOUR_MS - 1500,
      execution_time_ms: 100,
      input_token_count: 6,
      output_token_count: 4,
      token_cost: '0.000010',
      server_cost: '0.000001',
      total_cost: '0.000011',
      agent_id: 'flow-fetch',
      parent_span_id: 'flow-t1',
    });

    await insert_span(flow_project, {
      span_id: 'flow-b2',
      trace_id: 'flow-s2',
      ms_ago: 2 * HOUR_MS,
      execution_time_ms: 2000,
      input_token_count: 120,
      output_token_count: 80,
      token_cost: '0.000200',
      server_cost: '0.000020',
      total_cost: '0.000220',
      agent_id: 'flow-writer',
      model: 'claude-opus-4',
    });
    await insert_span(flow_project, {
      span_id: 'flow-t3',
      trace_id: 'flow-s2',
      ms_ago: 2 * HOUR_MS - 1000,
      execution_time_ms: 900,
      input_token_count: 30,
      output_token_count: 20,
      token_cost: '0.000050',
      server_cost: '0.000005',
      total_cost: '0.000055',
      agent_id: 'flow-search',
      parent_span_id: 'flow-b2',
    });
  });

  test('one node per agent, kind and depth from the tree position', async () => {
    const res = await api.projects[flow_project]!.metrics.flow.get({
      $headers: bearer(flow_token),
      $query: { time_window: '30d' },
    });
    expect(res.error).toBeNull();
    const { nodes } = res.data!;

    // Ordered by depth, then cost: the path reads left to right on the board, entry first. An agent
    // is one card however many ids and models it ran under.
    expect(nodes.map((node) => node.label)).toEqual([
      'Request',
      'Report Writer',
      'flow-planner',
      'flow-search',
      'flow-fetch',
    ]);

    // The request start carries no cost of its own: it stands for the moment a request begins.
    expect(nodes[0]).toMatchObject({
      kind: 'entry',
      label: 'Request',
      depth: 0,
      cost: '0.000000',
      request_count: 2,
      // The three spans that begin a request: the planner and writer in s1, the writer in s2.
      block_count: 3,
      // Nothing to open a drawer for: the entry stands for the request start, not an agent.
      agent_id: null,
      replica_count: 0,
    });

    const [, writer, planner, search, fetch] = nodes;
    // Both of the writer's executions collapse into one node, across two traces.
    expect(writer).toMatchObject({
      kind: 'agent',
      // One replica, so the drawer this card opens is addressed by the only id there is.
      agent_id: 'flow-writer',
      replica_count: 1,
      label: 'Report Writer',
      depth: 1,
      cost: '0.000660',
      llm_cost: '0.000600',
      harness_cost: '0.000060',
      // flow-b retried once: half its 0.000440 bought nothing.
      recoverable_cost: '0.000220',
      request_count: 2,
      block_count: 2,
      token_count: 600,
      retry_rate: 0.5,
      failed_rate: 0,
      cache_hit_ratio: null,
    });
    expect(writer!.p95_latency_ms).toBeCloseTo(2950, 6);

    // Never named by the runtime, so the label — and with it the id — falls back to the agent id.
    expect(planner).toMatchObject({
      kind: 'agent',
      agent_id: 'flow-planner',
      label: 'flow-planner',
      depth: 1,
      cost: '0.000330',
      request_count: 1,
      block_count: 1,
      token_count: 300,
      cache_hit_ratio: 0.5,
    });

    // Called by another agent rather than beginning the trace. That is a fact about depth and
    // nothing more: being called does not make it a different kind of thing.
    expect(search).toMatchObject({
      kind: 'agent',
      label: 'flow-search',
      depth: 2,
      cost: '0.000165',
      recoverable_cost: '0.000055',
      request_count: 2,
      block_count: 3,
      token_count: 150,
    });
    expect(search!.failed_rate).toBeCloseTo(1 / 3, 10);

    expect(fetch).toMatchObject({
      kind: 'agent',
      label: 'flow-fetch',
      depth: 3,
      cost: '0.000011',
      request_count: 1,
      block_count: 1,
    });

    // Nothing in the runtime's data separates a tool from an agent, so the graph never claims to:
    // every executed node is an agent however deep it ran, and depth is left to say the rest.
    expect(nodes.filter((node) => node.kind !== 'entry').map((node) => node.kind)).toEqual(
      Array(4).fill('agent')
    );

    // What a block bought is block-level detail; an agent has as many models as it has.
    expect(nodes.every((node) => !('model' in node))).toBe(true);
  });

  test('edges aggregate every parent → child transition across traces', async () => {
    const res = await api.projects[flow_project]!.metrics.flow.get({
      $headers: bearer(flow_token),
      $query: { time_window: '30d' },
    });
    expect(res.error).toBeNull();
    const { nodes, edges } = res.data!;

    // The writer's two top-level executions and the planner's one branch off the entry, then the
    // writer's three tool calls (two in s1, one in s2) and the nested fetch carry on down the tree.
    const id_of = (label: string): string => nodes.find((node) => node.label === label)!.id;

    // Ordered by call_count desc, then source, then target.
    expect(edges).toEqual([
      {
        id: `${id_of('Report Writer')}->${id_of('flow-search')}`,
        source: id_of('Report Writer'),
        target: id_of('flow-search'),
        call_count: 3,
        cost: '0.000165',
      },
      {
        id: `entry->${id_of('Report Writer')}`,
        source: 'entry',
        target: id_of('Report Writer'),
        call_count: 2,
        cost: '0.000660',
      },
      {
        id: `${id_of('flow-search')}->${id_of('flow-fetch')}`,
        source: id_of('flow-search'),
        target: id_of('flow-fetch'),
        call_count: 1,
        cost: '0.000011',
      },
      {
        id: `entry->${id_of('flow-planner')}`,
        source: 'entry',
        target: id_of('flow-planner'),
        call_count: 1,
        cost: '0.000330',
      },
    ]);

    // Every top-level block is reachable from the entry, so the board never strands a card.
    const reachable = new Set(edges.filter((e) => e.source === 'entry').map((e) => e.target));
    for (const node of nodes.filter((n) => n.depth === 1)) {
      expect(reachable.has(node.id)).toBe(true);
    }

    // Every endpoint resolves to a node the response actually ships.
    const ids = new Set(nodes.map((node) => node.id));
    for (const edge of edges) {
      expect(ids.has(edge.source)).toBe(true);
      expect(ids.has(edge.target)).toBe(true);
    }

    // An agent sits in the column of its shallowest call, so an edge could point back to a card
    // level with or to the left of its source. The board can only draw a step to the right.
    const depth_of = new Map(nodes.map((node) => [node.id, node.depth]));
    for (const edge of edges) {
      expect(depth_of.get(edge.target)!).toBeGreaterThan(depth_of.get(edge.source)!);
    }
  });

  test('the request entry carries no cost and the graph reconciles with the block breakdown', async () => {
    const [flow, blocks] = await Promise.all([
      api.projects[flow_project]!.metrics.flow.get({
        $headers: bearer(flow_token),
        $query: { time_window: '30d' },
      }),
      api.projects[flow_project]!.metrics.blocks.get({
        $headers: bearer(flow_token),
        $query: { time_window: '30d' },
      }),
    ]);
    expect(flow.error).toBeNull();
    expect(blocks.error).toBeNull();
    const { nodes, total_cost } = flow.data!;

    // Counting the roots would double this and add two agent-less nodes holding half the spend.
    expect(total_cost).toBe('0.001166');
    expect(total_cost).toBe(blocks.data!.total_cost);
    expect(nodes.some((node) => node.label === 'unattributed')).toBe(false);

    // The entry is cost-free, so re-attaching the trunk left every total untouched.
    const node_sum = nodes.reduce((sum, node) => sum + Number(node.cost), 0);
    expect(node_sum.toFixed(6)).toBe(total_cost);

    // A node is coarser than a block: the breakdown still groups by (agent_id, model), so a node
    // covers every one of its agent's rows and reconciles against their sum, not row for row. Both
    // sides resolve the label the same way, which is what makes the sum addressable at all.
    const executed = nodes.filter((node) => node.kind !== 'entry');
    const cost_by_label = new Map<string, number>();
    for (const block of blocks.data!.blocks) {
      cost_by_label.set(block.label, (cost_by_label.get(block.label) ?? 0) + Number(block.cost));
    }
    expect(new Set(cost_by_label.keys())).toEqual(new Set(executed.map((node) => node.label)));
    for (const node of executed) {
      expect(cost_by_label.get(node.label)!.toFixed(6)).toBe(node.cost);
    }
    expect(cost_by_label.has('Report Writer')).toBe(true);
  });

  test('a tool whose parent started before the window keeps its depth', async () => {
    const straddle = await create_project('metrics-flow-straddle@cc-forge.test');
    register_agent_name('straddle-agent');
    register_agent_name('straddle-tool');

    await insert_span(straddle.project_id, {
      span_id: 'straddle-mid',
      trace_id: 'flow-straddle',
      ms_ago: 40 * DAY_MS,
      execution_time_ms: 3000,
      input_token_count: 60,
      output_token_count: 40,
      token_cost: '0.000110',
      server_cost: '0.000000',
      total_cost: '0.000110',
      agent_id: 'straddle-agent',
      model: 'claude-opus-4',
    });
    await insert_span(straddle.project_id, {
      span_id: 'straddle-tool-1',
      trace_id: 'flow-straddle',
      ms_ago: 2 * HOUR_MS,
      execution_time_ms: 500,
      input_token_count: 30,
      output_token_count: 20,
      token_cost: '0.000055',
      server_cost: '0.000000',
      total_cost: '0.000055',
      agent_id: 'straddle-tool',
      parent_span_id: 'straddle-mid',
    });

    // 30d sees the tool call only. Its depth comes from the whole tree, so it stays a depth-2 tool
    // instead of being promoted to a top-level agent, and the edge to its out-of-window parent is
    // dropped rather than left pointing at a node that is not in the response. No request started
    // inside this window either, so there is no entry to hang it off.
    const scoped = await api.projects[straddle.project_id]!.metrics.flow.get({
      $headers: bearer(straddle.token),
      $query: { time_window: '30d' },
    });
    expect(scoped.error).toBeNull();
    expect(scoped.data!.total_cost).toBe('0.000055');
    expect(scoped.data!.nodes).toHaveLength(1);
    expect(scoped.data!.nodes[0]).toMatchObject({
      label: 'straddle-tool',
      kind: 'agent',
      depth: 2,
      block_count: 1,
    });
    expect(scoped.data!.edges).toEqual([]);

    // The quarter takes in the parent, so the transition surfaces.
    const quarter = await api.projects[straddle.project_id]!.metrics.flow.get({
      $headers: bearer(straddle.token),
      $query: { time_window: '1q' },
    });
    expect(quarter.error).toBeNull();
    expect(quarter.data!.total_cost).toBe('0.000165');
    const quarter_nodes = quarter.data!.nodes;
    expect(quarter_nodes.map((node) => node.label)).toEqual([
      'Request',
      'straddle-agent',
      'straddle-tool',
    ]);

    const id_of = (label: string): string => quarter_nodes.find((node) => node.label === label)!.id;
    expect(quarter.data!.edges).toEqual([
      {
        id: `${id_of('straddle-agent')}->${id_of('straddle-tool')}`,
        source: id_of('straddle-agent'),
        target: id_of('straddle-tool'),
        call_count: 1,
        cost: '0.000055',
      },
      {
        id: `entry->${id_of('straddle-agent')}`,
        source: 'entry',
        target: id_of('straddle-agent'),
        call_count: 1,
        cost: '0.000110',
      },
    ]);
  });

  test('a parentless agent keeps its own spend and what it called stays nested under it', async () => {
    const flat = await create_project('metrics-flow-rootless@cc-forge.test');
    register_agent_name('rootless-metrics', 'MetricsAgent');
    register_agent_name('rootless-price', 'PriceAgent');
    register_agent_name('rootless-risk', 'RiskAgent');

    // Parentless and agent-bearing: a real execution that happens to start the request.
    await insert_span(flat.project_id, {
      span_id: 'rootless-metrics-1',
      trace_id: 'flow-rootless',
      ms_ago: HOUR_MS,
      execution_time_ms: 174,
      input_token_count: 0,
      output_token_count: 0,
      token_cost: '0.000000',
      server_cost: '0.000500',
      total_cost: '0.000500',
      agent_id: 'rootless-metrics',
    });
    // Called by the agent above, so it belongs one level below it, not beside it.
    await insert_span(flat.project_id, {
      span_id: 'rootless-price-1',
      trace_id: 'flow-rootless',
      ms_ago: HOUR_MS - 10,
      execution_time_ms: 109,
      input_token_count: 0,
      output_token_count: 0,
      token_cost: '0.000000',
      server_cost: '0.000300',
      total_cost: '0.000300',
      agent_id: 'rootless-price',
      parent_span_id: 'rootless-metrics-1',
    });
    await insert_span(flat.project_id, {
      span_id: 'rootless-risk-1',
      trace_id: 'flow-rootless',
      ms_ago: HOUR_MS,
      execution_time_ms: 40,
      input_token_count: 0,
      output_token_count: 0,
      token_cost: '0.000000',
      server_cost: '0.000100',
      total_cost: '0.000100',
      agent_id: 'rootless-risk',
    });

    const res = await api.projects[flat.project_id]!.metrics.flow.get({
      $headers: bearer(flat.token),
      $query: { time_window: '30d' },
    });
    expect(res.error).toBeNull();
    const { nodes, edges, total_cost } = res.data!;

    // The calling agent is kept: its spend is its own, not a restatement of what it called.
    expect(total_cost).toBe('0.000900');
    expect(nodes.map((node) => `${node.label}@${node.depth}`)).toEqual([
      'Request@0',
      'MetricsAgent@1',
      'RiskAgent@1',
      'PriceAgent@2',
    ]);

    // Price hangs off Metrics, and off nothing else — in particular not off the entry.
    const label_of = new Map(nodes.map((node) => [node.id, node.label]));
    expect(
      edges.map((edge) => `${label_of.get(edge.source)}->${label_of.get(edge.target)}`).sort()
    ).toEqual(['Request->MetricsAgent', 'Request->RiskAgent', 'MetricsAgent->PriceAgent'].sort());
  });

  /**
   * The shape every real agent is written in: an LLM span, and a compute span hanging off it as its
   * child. Grouping on the model split that apart into two nodes a column away from each other,
   * joined by an arrow that described nothing — the two halves of one agent.
   */
  test('an agent’s model and compute spans are one node, with no arrow between them', async () => {
    const split = await create_project('metrics-flow-split@cc-forge.test');
    register_agent_name('split-agent', 'SplitAgent');
    register_agent_name('split-tool', 'SplitTool');

    // The LLM call, top level, and two models on the same agent for good measure.
    await insert_span(split.project_id, {
      span_id: 'split-llm-1',
      trace_id: 'flow-split',
      ms_ago: HOUR_MS,
      execution_time_ms: 900,
      input_token_count: 60,
      output_token_count: 40,
      token_cost: '0.000300',
      server_cost: '0.000000',
      total_cost: '0.000300',
      agent_id: 'split-agent',
      model: 'claude-opus-4',
    });
    await insert_span(split.project_id, {
      span_id: 'split-llm-2',
      trace_id: 'flow-split',
      ms_ago: HOUR_MS,
      execution_time_ms: 700,
      input_token_count: 20,
      output_token_count: 30,
      token_cost: '0.000100',
      server_cost: '0.000000',
      total_cost: '0.000100',
      errors: 1,
      agent_id: 'split-agent',
      model: 'claude-haiku-4',
    });
    // The agent's own compute span, written as a child of its LLM call.
    await insert_span(split.project_id, {
      span_id: 'split-compute',
      trace_id: 'flow-split',
      ms_ago: HOUR_MS,
      execution_time_ms: 120,
      input_token_count: 0,
      output_token_count: 0,
      token_cost: '0.000000',
      server_cost: '0.000200',
      total_cost: '0.000200',
      agent_id: 'split-agent',
      parent_span_id: 'split-llm-1',
    });
    // A genuinely different agent, so the board still has one real dependency to draw.
    await insert_span(split.project_id, {
      span_id: 'split-called',
      trace_id: 'flow-split',
      ms_ago: HOUR_MS,
      execution_time_ms: 80,
      input_token_count: 0,
      output_token_count: 0,
      token_cost: '0.000000',
      server_cost: '0.000055',
      total_cost: '0.000055',
      agent_id: 'split-tool',
      parent_span_id: 'split-compute',
    });

    const res = await api.projects[split.project_id]!.metrics.flow.get({
      $headers: bearer(split.token),
      $query: { time_window: '30d' },
    });
    expect(res.error).toBeNull();
    const { nodes, edges } = res.data!;

    // One card for the agent, whichever model it ran and whichever side of the split it billed.
    expect(nodes.map((node) => node.label)).toEqual(['Request', 'SplitAgent', 'SplitTool']);
    expect(nodes[1]).toMatchObject({
      label: 'SplitAgent',
      depth: 1,
      kind: 'agent',
      block_count: 3,
      cost: '0.000600',
      llm_cost: '0.000400',
      harness_cost: '0.000200',
      token_count: 150,
      replica_count: 1,
    });
    // Placed at its shallowest call: the compute span sits a level down, the agent does not.
    expect(nodes[1]!.depth).toBe(1);
    // Retries dilute across the whole agent, matching what the drawer reports for it.
    expect(nodes[1]!.retry_rate).toBeCloseTo(1 / 3, 10);

    // The agent -> its own compute span is gone; the call into a different agent survives.
    const label_of = new Map(nodes.map((node) => [node.id, node.label]));
    expect(
      edges.map((edge) => `${label_of.get(edge.source)}->${label_of.get(edge.target)}`)
    ).toEqual(['Request->SplitAgent', 'SplitAgent->SplitTool']);
    expect(edges.every((edge) => edge.source !== edge.target)).toBe(true);
  });

  /**
   * The platform finishes a task by duplicating an identical agent, so one logical agent runs as
   * several `agent_id`s under a single reported name. Those are instances of one agent — a board that
   * drew a card each would repeat the same agent as many times as it happened to be scaled out.
   */
  test('replicas sharing a name are one node, and a fan-out to them is one edge', async () => {
    const rep = await create_project('metrics-flow-replicas@cc-forge.test');
    register_agent_name('rep-router', 'RouterAgent');
    // Same name, three ids: what the runtime writes when it scales an agent out.
    register_agent_name('rep-price-b', 'PriceAgent');
    register_agent_name('rep-price-a', 'PriceAgent');
    // A near-miss that must NOT merge: distinct roles get distinct names.
    register_agent_name('rep-price-solo', 'PriceAgent Solo');

    await insert_span(rep.project_id, {
      span_id: 'rep-root',
      trace_id: 'flow-rep',
      ms_ago: HOUR_MS,
      execution_time_ms: 900,
      input_token_count: 40,
      output_token_count: 20,
      token_cost: '0.000200',
      server_cost: '0.000000',
      total_cost: '0.000200',
      agent_id: 'rep-router',
      model: 'claude-opus-4',
    });
    for (const [index, agent_id] of ['rep-price-a', 'rep-price-b'].entries()) {
      await insert_span(rep.project_id, {
        span_id: `rep-price-${index}`,
        trace_id: 'flow-rep',
        ms_ago: HOUR_MS - index,
        execution_time_ms: 100 + index * 100,
        input_token_count: 10,
        output_token_count: 5,
        token_cost: '0.000000',
        server_cost: '0.000050',
        total_cost: '0.000050',
        agent_id,
        parent_span_id: 'rep-root',
      });
    }
    await insert_span(rep.project_id, {
      span_id: 'rep-solo-1',
      trace_id: 'flow-rep',
      ms_ago: HOUR_MS,
      execution_time_ms: 50,
      input_token_count: 0,
      output_token_count: 0,
      token_cost: '0.000000',
      server_cost: '0.000011',
      total_cost: '0.000011',
      agent_id: 'rep-price-solo',
      parent_span_id: 'rep-root',
    });

    const res = await api.projects[rep.project_id]!.metrics.flow.get({
      $headers: bearer(rep.token),
      $query: { time_window: '30d' },
    });
    expect(res.error).toBeNull();
    const { nodes, edges } = res.data!;

    expect(nodes.map((node) => node.label)).toEqual([
      'Request',
      'RouterAgent',
      'PriceAgent',
      'PriceAgent Solo',
    ]);

    const price = nodes.find((node) => node.label === 'PriceAgent')!;
    expect(price).toMatchObject({
      replica_count: 2,
      block_count: 2,
      cost: '0.000100',
      depth: 2,
      kind: 'agent',
    });
    // No single replica speaks for the group, so the name addresses it and the drawer opens on that.
    expect(price.agent_id).toBe('PriceAgent');
    // A name that merely starts the same is a different agent, addressed by its only replica.
    const solo = nodes.find((node) => node.label === 'PriceAgent Solo')!;
    expect(solo.replica_count).toBe(1);
    expect(solo.agent_id).toBe('rep-price-solo');

    // Two calls, two replicas, one arrow: the router depends on PriceAgent, twice per request.
    const label_of = new Map(nodes.map((node) => [node.id, node.label]));
    expect(
      edges.map(
        (edge) => `${label_of.get(edge.source)}->${label_of.get(edge.target)} x${edge.call_count}`
      )
    ).toEqual([
      'RouterAgent->PriceAgent x2',
      'RouterAgent->PriceAgent Solo x1',
      'Request->RouterAgent x1',
    ]);
  });

  test('the drawer reports one aggregate for a name shared by several replicas', async () => {
    const rep = await create_project('metrics-drawer-replicas@cc-forge.test');
    register_agent_name('drawer-rep-a', 'DrawerAgent');
    register_agent_name('drawer-rep-b', 'DrawerAgent');

    for (const [index, agent_id] of ['drawer-rep-a', 'drawer-rep-b'].entries()) {
      await insert_span(rep.project_id, {
        span_id: `drawer-rep-span-${index}`,
        trace_id: 'drawer-rep',
        ms_ago: HOUR_MS,
        execution_time_ms: 200,
        input_token_count: 30,
        output_token_count: 20,
        token_cost: '0.000100',
        server_cost: '0.000020',
        total_cost: '0.000120',
        agent_id,
        model: 'claude-opus-4',
      });
    }

    // No single replica speaks for the group, so the name is what addresses it.
    const drawer = await api.projects[rep.project_id]!.metrics.agents['DrawerAgent']!.get({
      $query: {},
      $headers: bearer(rep.token),
    });
    expect(drawer.error).toBeNull();

    // One aggregate covering both replicas, not half the spend each.
    expect(drawer.data!.label).toBe('DrawerAgent');
    expect(drawer.data!.agent.replica_count).toBe(2);
    expect(drawer.data!.agent.block_count).toBe(2);
    expect(drawer.data!.agent.cost).toBe('0.000240');

    // The flow card advertises that same address, so clicking it opens exactly this drawer.
    const flow = await api.projects[rep.project_id]!.metrics.flow.get({
      $headers: bearer(rep.token),
      $query: { time_window: '30d' },
    });
    const card = flow.data!.nodes.find((node) => node.label === 'DrawerAgent')!;
    expect(card.agent_id).toBe('DrawerAgent');
    expect(card.cost).toBe(drawer.data!.agent.cost);

    // An id the runtime never ran is still a 404, not an empty aggregate.
    const missing = await api.projects[rep.project_id]!.metrics.agents['drawer-rep-ghost']!.get({
      $query: {},
      $headers: bearer(rep.token),
    });
    expect(missing.error?.status as number).toBe(404);
  });

  // `parent_span_id` has no foreign key, so nothing stops the receiver from writing a span that is
  // its own parent. The upward walk is bounded so that never hangs a request.
  test('a self-parented span is still counted once instead of looping', async () => {
    const cyclic = await create_project('metrics-flow-cyclic@cc-forge.test');
    register_agent_name('cyclic-agent');
    await insert_span(cyclic.project_id, {
      span_id: 'cyclic-self',
      trace_id: 'flow-cyclic',
      ms_ago: HOUR_MS,
      execution_time_ms: 500,
      input_token_count: 30,
      output_token_count: 20,
      token_cost: '0.000050',
      server_cost: '0.000005',
      total_cost: '0.000055',
      agent_id: 'cyclic-agent',
      parent_span_id: 'cyclic-self',
    });

    const res = await api.projects[cyclic.project_id]!.metrics.flow.get({
      $headers: bearer(cyclic.token),
      $query: { time_window: '30d' },
    });
    expect(res.error).toBeNull();
    expect(res.data!.total_cost).toBe('0.000055');
    expect(res.data!.nodes).toHaveLength(1);
    expect(res.data!.nodes[0]!.block_count).toBe(1);
  });

  test('a project with no telemetry spans returns an empty graph', async () => {
    const empty = await create_project('metrics-empty-flow@cc-forge.test');
    const res = await api.projects[empty.project_id]!.metrics.flow.get({
      $headers: bearer(empty.token),
      $query: { time_window: '30d' },
    });
    expect(res.error).toBeNull();
    expect(res.data).toEqual({
      project_id: empty.project_id,
      time_window: '30d',
      total_cost: '0.000000',
      nodes: [],
      edges: [],
    });
  });

  test('an unknown window is rejected by validation (422)', async () => {
    const res = await api.projects[flow_project]!.metrics.flow.get({
      $headers: bearer(flow_token),
      // @ts-expect-error deliberately invalid window
      $query: { time_window: 'forever' },
    });
    expect(res.error?.status as number).toBe(422);
  });

  test('a request without a token is rejected with 401', async () => {
    const res = await api.projects[flow_project]!.metrics.flow.get({
      $query: { time_window: '30d' },
    });
    expect(res.error?.status as number).toBe(401);
  });

  test("another company reads the project's flow", async () => {
    const other_company = await authenticate('metrics-flow-intruder@cc-forge.test');
    const res = await api.projects[flow_project]!.metrics.flow.get({
      $headers: bearer(other_company),
      $query: { time_window: '30d' },
    });
    expect(res.error).toBeNull();
    expect(res.data!.nodes.length).toBeGreaterThan(0);
  });
});

describe('stored runtime pricing', () => {
  let price_token: string;
  let price_project: string;

  beforeAll(async () => {
    ({ token: price_token, project_id: price_project } = await create_project(
      'metrics-pricing@cc-forge.test'
    ));
    register_agent_name('price-agent-stored');
    register_agent_name('price-agent-zero');

    await insert_span(price_project, {
      span_id: 'price-b-stored',
      trace_id: 'price-stored-session',
      ms_ago: 2 * HOUR_MS,
      execution_time_ms: 3600000,
      input_token_count: 600,
      output_token_count: 400,
      token_cost: '0.004600',
      server_cost: '0.000000',
      total_cost: '0.004600',
      agent_id: 'price-agent-stored',
      model: 'claude-opus-4',
    });

    // A zero reported cost stays zero even when tokens and execution time are present.
    await insert_span(price_project, {
      span_id: 'price-b-zero',
      trace_id: 'price-zero-session',
      ms_ago: HOUR_MS,
      execution_time_ms: 1800000,
      input_token_count: 300000,
      output_token_count: 100000,
      token_cost: '0.000000',
      server_cost: '0.000000',
      total_cost: '0.000000',
      agent_id: 'price-agent-zero',
      model: 'claude-opus-4',
    });
  });

  test('reads stored cost columns without repricing zero values', async () => {
    const res = await api.projects[price_project]!.metrics.blocks.get({
      $headers: bearer(price_token),
      $query: { time_window: '1d' },
    });
    expect(res.error).toBeNull();
    const by_agent = new Map(res.data!.blocks.map((block) => [block.agent_id, block]));

    expect(by_agent.get('price-agent-stored')).toMatchObject({
      llm_cost: '0.004600',
      harness_cost: '0.000000',
      cost: '0.004600',
    });
    expect(by_agent.get('price-agent-zero')).toMatchObject({
      llm_cost: '0.000000',
      harness_cost: '0.000000',
      cost: '0.000000',
    });
    expect(res.data!.total_cost).toBe('0.004600');
  });

  test('the KPI, timeseries, and requests surfaces agree on the same dollars', async () => {
    const [kpis, series, requests] = await Promise.all([
      api.projects[price_project]!.metrics.kpis.get({ $headers: bearer(price_token) }),
      api.projects[price_project]!.metrics.timeseries.get({
        $headers: bearer(price_token),
        $query: { time_window: '1d' },
      }),
      api.projects[price_project]!.requests.get({
        $headers: bearer(price_token),
        $query: { limit: 20, offset: 0 },
      }),
    ]);
    expect(kpis.error).toBeNull();
    expect(series.error).toBeNull();
    expect(requests.error).toBeNull();

    expect(kpis.data!.windows['1d']).toMatchObject({
      llm_cost: '0.004600',
      harness_cost: '0.000000',
      total_cost: '0.004600',
    });

    const series_total = series
      .data!.points.reduce((sum, point) => sum + Number(point.total_cost), 0)
      .toFixed(6);
    expect(series_total).toBe('0.004600');

    expect(
      requests.data!.items.find((item) => item.session_id === 'price-stored-session')
    ).toMatchObject({
      llm_cost: '0.004600',
      harness_cost: '0.000000',
      total_cost: '0.004600',
    });
    expect(
      requests.data!.items.find((item) => item.session_id === 'price-zero-session')
    ).toMatchObject({
      llm_cost: '0.000000',
      harness_cost: '0.000000',
      total_cost: '0.000000',
    });
  });
});

describe('every histogram bucket lists exactly the requests it counted', () => {
  let coh_token: string;
  let coh_project: string;

  // Five traces clustered so the buckets come back uneven: some hold two, one holds none, and the
  // largest value sits exactly on the top bucket's upper bound.
  beforeAll(async () => {
    ({ token: coh_token, project_id: coh_project } = await create_project(
      'metrics-coherence@cc-forge.test'
    ));
    register_agent_name('coh-agent');

    const steps = [1, 1, 2, 4, 4];
    for (const [index, step] of steps.entries()) {
      await insert_span(coh_project, {
        span_id: `coh-${index}`,
        trace_id: `coh-trace-${index}`,
        ms_ago: (index + 1) * HOUR_MS,
        execution_time_ms: step * 100,
        input_token_count: step * 10,
        output_token_count: 0,
        token_cost: (step * 0.001).toFixed(6),
        server_cost: '0.000000',
        total_cost: (step * 0.001).toFixed(6),
        agent_id: 'coh-agent',
        model: 'claude-opus-4',
      });
    }
  });

  for (const metric of ['tokens_per_request', 'cost_per_request', 'latency'] as const) {
    test(`${metric}: every bucket's count equals the listing it filters`, async () => {
      const distribution = await api.projects[coh_project]!.metrics.distribution.get({
        $headers: bearer(coh_token),
        $query: { metric, time_window: '30d', buckets: 4 },
      });
      expect(distribution.error).toBeNull();
      const { buckets, request_count } = distribution.data!;
      expect(buckets).toHaveLength(4);
      expect(request_count).toBe(5);

      let listed = 0;
      for (const bucket of buckets) {
        const page = await api.projects[coh_project]!.requests.get({
          $query: {
            limit: 100,
            offset: 0,
            metric,
            min: bucket.lower,
            max: bucket.upper,
            time_window: '30d',
          },
          $headers: bearer(coh_token),
        });
        expect(page.error).toBeNull();
        expect(page.data!.total).toBe(bucket.count);
        expect(page.data!.items).toHaveLength(bucket.count);
        listed += page.data!.total;
      }

      // The buckets partition the window, and the last one includes its upper bound.
      expect(listed).toBe(request_count);
      expect(buckets.map((bucket) => bucket.count)).toEqual([2, 1, 0, 2]);
      expect(buckets[3]!.count).toBeGreaterThan(0);
    });
  }
});

describe('project scoping at the data boundary', () => {
  test('a span with no canyon.project.id is invisible to KPI and requests', async () => {
    const owner = await create_project('metrics-boundary-orphan@cc-forge.test');
    register_agent_name('orphan-agent');
    await insert_span(owner.project_id, {
      span_id: 'boundary-owned-1',
      trace_id: 'boundary-owned',
      ms_ago: HOUR_MS,
      execution_time_ms: 100,
      input_token_count: 10,
      output_token_count: 10,
      token_cost: '0.000100',
      server_cost: '0.000010',
      total_cost: '0.000110',
      agent_id: 'orphan-agent',
    });

    // Written straight to the table with no project attribute at all.
    const start = nanos_ago(HOUR_MS);
    await db.insert(otelSpans).values({
      span_id: 'boundary-orphan-1',
      trace_id: 'boundary-orphan',
      name: 'orphan-agent',
      start_time_unix_nano: start,
      end_time_unix_nano: start + 100n * NANOS_PER_MS,
      attributes: { [GEN_AI.USAGE_COST]: 9.999, [GEN_AI.INPUT_TOKENS]: 5000 },
    });

    const kpis = await api.projects[owner.project_id]!.metrics.kpis.get({
      $headers: bearer(owner.token),
    });
    expect(kpis.error).toBeNull();
    expect(kpis.data!.windows['30d']).toMatchObject({
      request_count: 1,
      block_count: 1,
      tokens: 20,
      total_cost: '0.000110',
    });

    const requests = await api.projects[owner.project_id]!.requests.get({
      $query: { limit: 20, offset: 0 },
      $headers: bearer(owner.token),
    });
    expect(requests.error).toBeNull();
    expect(requests.data!.total).toBe(1);
    expect(requests.data!.items.map((item) => item.session_id)).toEqual(['boundary-owned']);
  });

  test('one trace id in two projects stays split across KPI, distribution, and requests', async () => {
    const owner = await create_project('metrics-boundary-shared@cc-forge.test');
    const second = await api.projects.post(
      { name: 'Second', files: [{ path: 'workflow.py', content: 'def run(): pass\n' }] },
      { headers: bearer(owner.token) }
    );
    expect(second.error).toBeNull();
    const project_b = second.data!.project.id;

    register_agent_name('shared-agent');
    await insert_span(owner.project_id, {
      span_id: 'shared-a-1',
      trace_id: 'shared-trace',
      ms_ago: HOUR_MS,
      execution_time_ms: 100,
      input_token_count: 10,
      output_token_count: 0,
      token_cost: '0.000100',
      server_cost: '0.000000',
      total_cost: '0.000100',
      agent_id: 'shared-agent',
    });
    await insert_span(project_b, {
      span_id: 'shared-b-1',
      trace_id: 'shared-trace',
      ms_ago: HOUR_MS,
      execution_time_ms: 900,
      input_token_count: 700,
      output_token_count: 0,
      token_cost: '0.000700',
      server_cost: '0.000000',
      total_cost: '0.000700',
      agent_id: 'shared-agent',
    });

    for (const [project_id, cost, tokens, latency] of [
      [owner.project_id, '0.000100', 10, 100],
      [project_b, '0.000700', 700, 900],
    ] as const) {
      const kpis = await api.projects[project_id]!.metrics.kpis.get({
        $headers: bearer(owner.token),
      });
      expect(kpis.data!.windows['30d']).toMatchObject({
        request_count: 1,
        block_count: 1,
        tokens,
        total_cost: cost,
      });

      const distribution = await api.projects[project_id]!.metrics.distribution.get({
        $headers: bearer(owner.token),
        $query: { metric: 'latency', time_window: '30d', buckets: 4 },
      });
      expect(distribution.data!.request_count).toBe(1);
      expect(distribution.data!.max).toBe(latency);

      const requests = await api.projects[project_id]!.requests.get({
        $query: { limit: 20, offset: 0 },
        $headers: bearer(owner.token),
      });
      expect(requests.data!.total).toBe(1);
      expect(requests.data!.items[0]).toMatchObject({
        session_id: 'shared-trace',
        block_count: 1,
        total_cost: cost,
      });
    }
  });

  test('malformed numeric attributes read as absent instead of failing', async () => {
    const owner = await create_project('metrics-boundary-malformed@cc-forge.test');
    const start = nanos_ago(HOUR_MS);
    await db.insert(otelSpans).values({
      span_id: 'malformed-1',
      trace_id: 'malformed-trace',
      name: 'MalformedAgent',
      start_time_unix_nano: start,
      end_time_unix_nano: start + 400n * NANOS_PER_MS,
      attributes: {
        [PROJECT_ID_ATTRIBUTE]: owner.project_id,
        [GEN_AI.AGENT_ID]: 'malformed-agent',
        [GEN_AI.USAGE_COST]: 'free',
        [RUNTIME_ATTRIBUTES.TOKEN_COST]: ['0.5'],
        [RUNTIME_ATTRIBUTES.SERVER_COST]: { amount: 1 },
        [GEN_AI.INPUT_TOKENS]: 'twelve',
        [GEN_AI.OUTPUT_TOKENS]: -3,
        [RUNTIME_ATTRIBUTES.ERROR_COUNT]: 1.5,
        [GEN_AI.CACHE_READ_INPUT_TOKENS]: 'lots',
      },
    });

    const kpis = await api.projects[owner.project_id]!.metrics.kpis.get({
      $headers: bearer(owner.token),
    });
    expect(kpis.error).toBeNull();
    expect(kpis.data!.windows['30d']).toMatchObject({
      request_count: 1,
      block_count: 1,
      tokens: 0,
      total_cost: '0.000000',
      llm_cost: '0.000000',
      harness_cost: '0.000000',
      recoverable_cost: '0.000000',
      costed_block_count: 0,
      costed_request_count: 0,
      per_block_cost: null,
      per_costed_request_cost: null,
    });

    const blocks = await api.projects[owner.project_id]!.metrics.blocks.get({
      $headers: bearer(owner.token),
      $query: { time_window: '30d' },
    });
    expect(blocks.error).toBeNull();
    expect(blocks.data!.total_cost).toBe('0.000000');
    expect(blocks.data!.blocks[0]).toMatchObject({
      agent_id: 'malformed-agent',
      block_count: 1,
      token_count: 0,
      cost: '0.000000',
      recoverable_cost: '0.000000',
      retry_rate: 0,
      failed_rate: 0,
      cache_hit_ratio: null,
    });
  });

  test('a parent in another project is never followed by this project flow', async () => {
    const owner = await create_project('metrics-boundary-parent@cc-forge.test');
    const second = await api.projects.post(
      { name: 'Parent Holder', files: [{ path: 'workflow.py', content: 'def run(): pass\n' }] },
      { headers: bearer(owner.token) }
    );
    expect(second.error).toBeNull();
    const project_b = second.data!.project.id;

    register_agent_name('foreign-parent');
    register_agent_name('local-child');

    await insert_span(project_b, {
      span_id: 'xproj-parent-1',
      trace_id: 'xproj-trace',
      ms_ago: HOUR_MS,
      execution_time_ms: 1000,
      input_token_count: 100,
      output_token_count: 0,
      token_cost: '0.000900',
      server_cost: '0.000000',
      total_cost: '0.000900',
      agent_id: 'foreign-parent',
    });
    await insert_span(owner.project_id, {
      span_id: 'xproj-child-1',
      trace_id: 'xproj-trace',
      parent_span_id: 'xproj-parent-1',
      ms_ago: HOUR_MS,
      execution_time_ms: 100,
      input_token_count: 10,
      output_token_count: 0,
      token_cost: '0.000050',
      server_cost: '0.000000',
      total_cost: '0.000050',
      agent_id: 'local-child',
    });

    const flow = await api.projects[owner.project_id]!.metrics.flow.get({
      $headers: bearer(owner.token),
      $query: { time_window: '30d' },
    });
    expect(flow.error).toBeNull();
    const { nodes, edges } = flow.data!;

    // The foreign parent is neither a node nor an ancestor, so the child begins the trace here.
    expect(nodes.map((node) => node.label)).toEqual(['Request', 'local-child']);
    expect(flow.data!.total_cost).toBe('0.000050');
    const child = nodes.find((node) => node.label === 'local-child')!;
    expect(child.depth).toBe(1);

    const label_of = new Map(nodes.map((node) => [node.id, node.label]));
    expect(
      edges.map((edge) => `${label_of.get(edge.source)}->${label_of.get(edge.target)}`)
    ).toEqual(['Request->local-child']);
  });
});

describe('every executed agent has an address', () => {
  let addr_token: string;
  let addr_project: string;

  beforeAll(async () => {
    ({ token: addr_token, project_id: addr_project } = await create_project(
      'metrics-address@cc-forge.test'
    ));
    // One agent reporting a single id, one reporting two, and one reporting none at all.
    register_agent_name('addr-solo', 'SoloAgent');
    register_agent_name('addr-rep-a', 'ReplicaAgent');
    register_agent_name('addr-rep-b', 'ReplicaAgent');

    const spans: { span_id: string; agent_id?: string; parent_span_id?: string }[] = [
      { span_id: 'addr-solo-1', agent_id: 'addr-solo' },
      { span_id: 'addr-rep-1', agent_id: 'addr-rep-a', parent_span_id: 'addr-solo-1' },
      { span_id: 'addr-rep-2', agent_id: 'addr-rep-b', parent_span_id: 'addr-solo-1' },
      { span_id: 'addr-nameless-1', parent_span_id: 'addr-solo-1' },
    ];
    for (const span of spans) {
      await insert_span(addr_project, {
        ...span,
        trace_id: 'addr-trace',
        ms_ago: HOUR_MS,
        execution_time_ms: 100,
        input_token_count: 5,
        output_token_count: 5,
        token_cost: '0.000010',
        server_cost: '0.000001',
        total_cost: '0.000011',
      });
    }
  });

  test('every block group is addressable', async () => {
    const res = await api.projects[addr_project]!.metrics.blocks.get({
      $headers: bearer(addr_token),
      $query: { time_window: '30d' },
    });
    expect(res.error).toBeNull();

    const blocks = res.data!.blocks;
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block.agent_id).not.toBeNull();
      expect(block.agent_id).not.toBe('');
    }
    expect(blocks.map((block) => block.label).sort()).toEqual([
      'ReplicaAgent',
      'SoloAgent',
      UNATTRIBUTED_NAME,
    ]);
  });

  test('the entry is the only flow node without an address', async () => {
    const res = await api.projects[addr_project]!.metrics.flow.get({
      $headers: bearer(addr_token),
      $query: { time_window: '30d' },
    });
    expect(res.error).toBeNull();

    const nodes = res.data!.nodes;
    const unaddressed = nodes.filter((node) => node.agent_id === null);
    expect(unaddressed).toHaveLength(1);
    expect(unaddressed[0]!.kind).toBe('entry');

    for (const node of nodes.filter((node) => node.kind === 'agent')) {
      expect(node.agent_id).not.toBeNull();
      expect(node.agent_id).not.toBe('');
    }
  });

  test('each address the flow advertises opens a drawer', async () => {
    const flow = await api.projects[addr_project]!.metrics.flow.get({
      $headers: bearer(addr_token),
      $query: { time_window: '30d' },
    });
    const addresses = flow
      .data!.nodes.filter((node) => node.kind === 'agent')
      .map((node) => node.agent_id!);
    expect(addresses).toHaveLength(3);

    for (const agent_id of addresses) {
      const drawer = await api.projects[addr_project]!.metrics.agents[agent_id]!.get({
        $query: {},
        $headers: bearer(addr_token),
      });
      expect(drawer.error).toBeNull();
      expect(drawer.data!.agent.block_count).toBeGreaterThan(0);
    }
  });
});

describe('metrics auth & access', () => {
  test('requests without a token are rejected with 401', async () => {
    const res = await api.projects[project_id]!.metrics.kpis.get();
    expect(res.error?.status as number).toBe(401);
  });

  test("another company reads the project's metrics", async () => {
    const other_company = await authenticate('metrics-intruder@cc-forge.test');
    const res = await api.projects[project_id]!.metrics.kpis.get({
      $headers: bearer(other_company),
    });
    expect(res.error).toBeNull();
    expect(res.data!.windows['30d'].block_count).toBeGreaterThan(0);
  });

  test('an unknown project id is 404 projects.not_found', async () => {
    const token = await authenticate('metrics-unknown-project@cc-forge.test');
    const unknown = '00000000-0000-4000-8000-000000000000';

    const res = await api.projects[unknown]!.metrics.kpis.get({ $headers: bearer(token) });

    expect(res.error?.status as number).toBe(404);
    expect((res.error?.value as { error?: string })?.error).toBe('projects.not_found');
  });
});

describe('a request spends the sum of its spans', () => {
  let once_token: string;
  let once_project: string;

  beforeAll(async () => {
    ({ token: once_token, project_id: once_project } = await create_project(
      'metrics-sum-of-spans@cc-forge.test'
    ));
    register_agent_name('summed-agent');

    await insert_span(once_project, {
      span_id: 'summed-1',
      trace_id: 'summed-trace',
      ms_ago: 2 * HOUR_MS,
      execution_time_ms: 2000,
      input_token_count: 60,
      output_token_count: 40,
      token_cost: '0.000200',
      server_cost: '0.000020',
      total_cost: '0.000220',
      agent_id: 'summed-agent',
      model: 'claude-opus-4',
    });
    await insert_span(once_project, {
      span_id: 'summed-2',
      trace_id: 'summed-trace',
      ms_ago: 2 * HOUR_MS - 2000,
      execution_time_ms: 3000,
      input_token_count: 120,
      output_token_count: 80,
      token_cost: '0.000400',
      server_cost: '0.000040',
      total_cost: '0.000440',
      agent_id: 'summed-agent',
      model: 'claude-opus-4',
    });
  });

  test('KPIs sum the executions once', async () => {
    const res = await api.projects[once_project]!.metrics.kpis.get({
      $headers: bearer(once_token),
    });
    const time_window = res.data!.windows['30d'];
    expect(time_window.block_count).toBe(2);
    expect(time_window.total_cost).toBe('0.000660');
    expect(time_window.llm_cost).toBe('0.000600');
    expect(time_window.harness_cost).toBe('0.000060');
    expect(time_window.tokens).toBe(300);
  });

  test('the block breakdown has no agent-less group', async () => {
    const res = await api.projects[once_project]!.metrics.blocks.get({
      $headers: bearer(once_token),
      $query: { time_window: '30d' },
    });
    expect(res.data!.total_cost).toBe('0.000660');
    expect(res.data!.blocks).toHaveLength(1);
    expect(res.data!.blocks[0]!.agent_id).toBe('summed-agent');
    expect(res.data!.blocks[0]!.block_count).toBe(2);
    expect(res.data!.blocks.some((block) => block.agent_id === null)).toBe(false);
  });

  test('the requests listing rolls up the executions once', async () => {
    const res = await api.projects[once_project]!.requests.get({
      $headers: bearer(once_token),
      $query: { limit: 20, offset: 0 },
    });
    const request = res.data!.items[0]!;
    expect(request.block_count).toBe(2);
    expect(request.total_cost).toBe('0.000660');
    expect(request.token_count).toBe(300);
  });

  test('a single-execution run with no children still counts', async () => {
    const { token, project_id: solo_project } = await create_project('metrics-solo@cc-forge.test');
    await insert_span(solo_project, {
      span_id: 'solo-only',
      trace_id: 'solo-session',
      ms_ago: HOUR_MS,
      execution_time_ms: 1000,
      input_token_count: 10,
      output_token_count: 10,
      token_cost: '0.000100',
      server_cost: '0.000010',
      total_cost: '0.000110',
    });

    const res = await api.projects[solo_project]!.metrics.kpis.get({ $headers: bearer(token) });
    expect(res.data!.windows['30d'].block_count).toBe(1);
    expect(res.data!.windows['30d'].total_cost).toBe('0.000110');
  });
});
