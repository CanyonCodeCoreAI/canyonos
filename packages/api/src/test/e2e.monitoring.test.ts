import { beforeAll, describe, expect, test } from 'bun:test';

import { db } from '@api/db/client';
import { otelLogs, otelMetrics, otelSpans } from '@api/db/schema';
import {
  GEN_AI,
  PROJECT_ID_ATTRIBUTE,
  RUNTIME_ATTRIBUTES,
  STATUS_CODE,
} from '@api/modules/metrics/metrics.contract';
import {
  MACHINE_UTILIZATION_METRICS,
  RESOURCE_PROJECT_ATTRIBUTE,
} from '@api/modules/monitoring/monitoring.signals';
import type { MetricsWindow } from '@api/modules/metrics/metrics.types';
import type { MonitoringGrid, MonitoringLogsQuery } from '@api/modules/monitoring/monitoring.types';

import { api, setupE2ETests } from './e2e.setup';
import { authenticate, bearer, create_test_project } from './project-test.utils';

setupE2ETests();

const NANOS_PER_MS = 1_000_000n;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// One frozen reference time, so every fixture's offset is exact relative to the others.
const BASE_MS = Date.now();

const nanos_ago = (ms_ago: number): bigint => BigInt(BASE_MS - Math.round(ms_ago)) * NANOS_PER_MS;

/** The second-precision UTC stamp the monitoring rows carry in `at`. */
const at_ago = (ms_ago: number): string =>
  `${new Date(BASE_MS - Math.round(ms_ago)).toISOString().slice(0, 19)}Z`;

interface SpanFixture {
  readonly span_id: string;
  readonly trace_id: string;
  readonly ms_ago: number;
  readonly duration_ms: number;
  readonly name?: string;
  readonly parent_span_id?: string;
  readonly failed?: boolean;
  readonly status_message?: string;
  readonly attributes?: Record<string, unknown>;
  readonly input?: string;
  readonly output?: string;
}

const span_attributes = (project_id: string, span: SpanFixture): Record<string, unknown> => ({
  [PROJECT_ID_ATTRIBUTE]: project_id,
  ...span.attributes,
});

async function write_span(project_id: string, span: SpanFixture): Promise<void> {
  const start = nanos_ago(span.ms_ago);
  await db.insert(otelSpans).values({
    span_id: span.span_id,
    trace_id: span.trace_id,
    parent_span_id: span.parent_span_id ?? null,
    name: span.name ?? span.span_id,
    status_code: span.failed === true ? STATUS_CODE.ERROR : STATUS_CODE.UNSET,
    status_message: span.status_message ?? null,
    start_time_unix_nano: start,
    end_time_unix_nano: start + BigInt(span.duration_ms) * NANOS_PER_MS,
    attributes: span_attributes(project_id, span),
    input: span.input ?? null,
    output: span.output ?? null,
  });
}

interface MetricFixture {
  readonly metric_name: string;
  readonly ms_ago: number;
  readonly value: number;
  readonly host?: string;
  readonly service_name?: string;
}

async function write_metric(project_id: string, metric: MetricFixture): Promise<void> {
  await db.insert(otelMetrics).values({
    service_name: metric.service_name ?? 'canyonos-node',
    resource_attributes: {
      [RESOURCE_PROJECT_ATTRIBUTE]: project_id,
      ...(metric.host === undefined ? {} : { 'host.name': metric.host }),
    },
    metric_name: metric.metric_name,
    metric_type: 'gauge',
    time_unix_nano: nanos_ago(metric.ms_ago),
    value: metric.value,
  });
}

interface LogFixture {
  readonly ms_ago: number;
  readonly body: string;
  /** Null writes a log that names no project in its resource. */
  readonly project_id: string | null;
  readonly severity_text?: string;
  readonly severity_number?: number;
  readonly service_name?: string;
  readonly trace_id?: string;
  readonly span_id?: string;
  readonly attributes?: Record<string, unknown>;
}

async function write_log(log: LogFixture): Promise<void> {
  const at = nanos_ago(log.ms_ago);
  await db.insert(otelLogs).values({
    service_name: log.service_name ?? null,
    resource_attributes:
      log.project_id === null ? {} : { [RESOURCE_PROJECT_ATTRIBUTE]: log.project_id },
    time_unix_nano: at,
    observed_time_unix_nano: at,
    severity_text: log.severity_text ?? null,
    severity_number: log.severity_number ?? null,
    body: log.body,
    trace_id: log.trace_id ?? null,
    span_id: log.span_id ?? null,
    attributes: log.attributes ?? {},
  });
}

/** Index of the grid bucket a fixture written `ms_ago` falls in. */
function bucket_of(grid: MonitoringGrid, ms_ago: number): number {
  const at = BASE_MS - ms_ago;
  const index = grid.bucket_start_ats.findIndex((start_at) => {
    const start = Date.parse(start_at);
    return at >= start && at < start + grid.bucket_seconds * 1000;
  });
  if (index === -1) throw new Error(`No bucket covers ${ms_ago}ms ago`);
  return index;
}

/** A grid-long series that is `fill` everywhere except the given buckets. */
function grid_values(
  grid: MonitoringGrid,
  fill: number | null,
  points: readonly [ms_ago: number, value: number][]
): (number | null)[] {
  const values: (number | null)[] = grid.bucket_start_ats.map(() => fill);
  for (const [ms_ago, value] of points) values[bucket_of(grid, ms_ago)] = value;
  return values;
}

async function create_project(
  token: string,
  name = 'Monitoring Project'
): Promise<{ project_id: string }> {
  return create_test_project(token, { name });
}

const SECONDS_PER_HOUR = 3600;

let token: string;

beforeAll(async () => {
  token = await authenticate('monitoring-owner@canyonos.test');
});

describe('GET /projects/:project_id/monitoring/series', () => {
  let project_id: string;
  let foreign_id: string;

  /**
   * Fixture (1d grid):
   * - 2.5h ago: trace `ser-a` (two failed spans, 1000ms wall clock) and `ser-b` (3000ms, ok).
   * - 5.5h ago: trace `ser-c` (500ms, ok).
   * - 2.5h ago: CPU readings 40 and 60 for this project; a memory reading that is not CPU.
   * - The foreign project has a span and a CPU reading in the same bucket.
   */
  beforeAll(async () => {
    ({ project_id } = await create_project(token));
    ({ project_id: foreign_id } = await create_project(token, 'Foreign Monitoring'));

    await write_span(project_id, {
      span_id: 'ser-a-root',
      trace_id: 'ser-a',
      ms_ago: 2.5 * HOUR_MS,
      duration_ms: 1000,
      failed: true,
    });
    await write_span(project_id, {
      span_id: 'ser-a-child',
      trace_id: 'ser-a',
      parent_span_id: 'ser-a-root',
      ms_ago: 2.5 * HOUR_MS - 200,
      duration_ms: 800,
      failed: true,
    });
    await write_span(project_id, {
      span_id: 'ser-b',
      trace_id: 'ser-b',
      ms_ago: 2.5 * HOUR_MS,
      duration_ms: 3000,
    });
    await write_span(project_id, {
      span_id: 'ser-c',
      trace_id: 'ser-c',
      ms_ago: 5.5 * HOUR_MS,
      duration_ms: 500,
    });
    await write_metric(project_id, {
      metric_name: MACHINE_UTILIZATION_METRICS.cpu,
      ms_ago: 2.5 * HOUR_MS,
      value: 40,
    });
    await write_metric(project_id, {
      metric_name: MACHINE_UTILIZATION_METRICS.cpu,
      ms_ago: 2.5 * HOUR_MS - 1000,
      value: 60,
    });
    await write_metric(project_id, {
      metric_name: MACHINE_UTILIZATION_METRICS.memory,
      ms_ago: 2.5 * HOUR_MS,
      value: 99,
    });

    await write_span(foreign_id, {
      span_id: 'ser-foreign',
      trace_id: 'ser-foreign',
      ms_ago: 2.5 * HOUR_MS,
      duration_ms: 9000,
      failed: true,
    });
    await write_metric(foreign_id, {
      metric_name: MACHINE_UTILIZATION_METRICS.cpu,
      ms_ago: 2.5 * HOUR_MS,
      value: 100,
    });
  });

  test('the four golden signals on one 24-hour grid, scoped to the project', async () => {
    const res = await api.projects[project_id]!.monitoring.series.get({
      $headers: bearer(token),
      $query: { time_window: '1d' },
    });
    expect(res.error).toBeNull();
    const grid = res.data!;
    const recent = 2.5 * HOUR_MS;
    const older = 5.5 * HOUR_MS;

    expect(res.data).toEqual({
      project_id,
      time_window: '1d',
      bucket_seconds: SECONDS_PER_HOUR,
      bucket_start_ats: grid.bucket_start_ats,
      series: [
        {
          signal: 'traffic',
          unit: 'requests',
          kind: 'flow',
          values: grid_values(grid, 0, [
            [recent, 2],
            [older, 1],
          ]),
          average: 3 / 24,
          peak: 2,
          latest: 0,
          samples: 24,
        },
        {
          // `ser-a` failed in both of its spans and still counts once.
          signal: 'errors',
          unit: 'requests',
          kind: 'flow',
          values: grid_values(grid, 0, [[recent, 1]]),
          average: 1 / 24,
          peak: 1,
          latest: 0,
          samples: 24,
        },
        {
          // p95 over the traces' wall clocks (1000ms and 3000ms), not over the three spans.
          signal: 'latency',
          unit: 'ms',
          kind: 'stock',
          values: grid_values(grid, null, [
            [recent, 2900],
            [older, 500],
          ]),
          average: 1700,
          peak: 2900,
          latest: 2900,
          samples: 2,
        },
        {
          signal: 'saturation',
          unit: 'percent',
          kind: 'stock',
          values: grid_values(grid, null, [[recent, 50]]),
          average: 50,
          peak: 50,
          latest: 50,
          samples: 1,
        },
      ],
    });
  });

  test('the grid is 24 hourly buckets ending on the current hour', async () => {
    const res = await api.projects[project_id]!.monitoring.series.get({
      $headers: bearer(token),
      $query: { time_window: '1d' },
    });
    const starts = res.data!.bucket_start_ats.map((start_at) => Date.parse(start_at));

    expect(starts).toHaveLength(24);
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]! - starts[i - 1]!).toBe(HOUR_MS);
    }
    expect(starts.at(-1)).toBe(Math.floor(Date.now() / HOUR_MS) * HOUR_MS);
  });

  test('the longer windows are 30 buckets each', async () => {
    const windows: [MetricsWindow, number][] = [
      ['7d', (7 * DAY_MS) / 30 / 1000],
      ['30d', DAY_MS / 1000],
      ['1q', (90 * DAY_MS) / 30 / 1000],
    ];
    for (const [time_window, bucket_seconds] of windows) {
      const res = await api.projects[project_id]!.monitoring.series.get({
        $headers: bearer(token),
        $query: { time_window },
      });
      expect(res.error).toBeNull();
      expect(res.data!.time_window).toBe(time_window);
      expect(res.data!.bucket_seconds).toBe(bucket_seconds);
      expect(res.data!.bucket_start_ats).toHaveLength(30);
      for (const series of res.data!.series) expect(series.values).toHaveLength(30);
    }
  });

  test('a project with no telemetry has zero flows and unmeasured stocks', async () => {
    const { project_id: empty_id } = await create_project(token, 'Empty Series');
    const res = await api.projects[empty_id]!.monitoring.series.get({
      $headers: bearer(token),
      $query: { time_window: '1d' },
    });
    expect(res.error).toBeNull();

    const zeros = Array.from({ length: 24 }, () => 0);
    const nulls = Array.from({ length: 24 }, () => null);
    const flow = { values: zeros, average: 0, peak: 0, latest: 0, samples: 24 };
    const unmeasured = { values: nulls, average: null, peak: null, latest: null, samples: 0 };
    expect(res.data).toEqual({
      project_id: empty_id,
      time_window: '1d',
      bucket_seconds: SECONDS_PER_HOUR,
      bucket_start_ats: res.data!.bucket_start_ats,
      series: [
        { signal: 'traffic', unit: 'requests', kind: 'flow', ...flow },
        { signal: 'errors', unit: 'requests', kind: 'flow', ...flow },
        { signal: 'latency', unit: 'ms', kind: 'stock', ...unmeasured },
        { signal: 'saturation', unit: 'percent', kind: 'stock', ...unmeasured },
      ],
    });
  });

  test('the foreign project sees only its own trace and reading', async () => {
    const res = await api.projects[foreign_id]!.monitoring.series.get({
      $headers: bearer(token),
      $query: { time_window: '1d' },
    });
    const by_signal = Object.fromEntries(res.data!.series.map((series) => [series.signal, series]));

    expect(by_signal.traffic!.peak).toBe(1);
    expect(by_signal.errors!.peak).toBe(1);
    expect(by_signal.latency!.peak).toBe(9000);
    expect(by_signal.saturation!.average).toBe(100);
  });

  test('an unknown window is rejected by validation (422)', async () => {
    const res = await api.projects[project_id]!.monitoring.series.get({
      $headers: bearer(token),
      // @ts-expect-error -- an invalid window is the point of the test
      $query: { time_window: '2d' },
    });
    expect(res.error?.status as number).toBe(422);
  });
});

describe('GET /projects/:project_id/monitoring/logs', () => {
  let project_id: string;
  let foreign_id: string;

  const price_agent = { 'canyonos.agent.name': 'PriceAgent', 'canyonos.agent.id': 'price-0' };

  /**
   * Newest first: `hello` (1h), `boom` (2h, scoped only through its trace), `fatal` (3h),
   * `warn` (4h, no agent attributes), `bare` (5h, no agent and no service). The foreign project's
   * log, a log on the foreign trace, and a log from two days ago never show.
   */
  beforeAll(async () => {
    ({ project_id } = await create_project(token, 'Logs Project'));
    ({ project_id: foreign_id } = await create_project(token, 'Foreign Logs'));

    await write_span(project_id, {
      span_id: 'log-span',
      trace_id: 'log-trace',
      ms_ago: 2 * HOUR_MS,
      duration_ms: 100,
    });
    await write_span(foreign_id, {
      span_id: 'log-foreign-span',
      trace_id: 'log-foreign-trace',
      ms_ago: 2 * HOUR_MS,
      duration_ms: 100,
    });

    await write_log({
      project_id,
      ms_ago: HOUR_MS,
      body: 'hello',
      severity_text: 'INFO',
      severity_number: 9,
      service_name: 'price-svc',
      attributes: { ...price_agent, 'http.route': '/quote' },
    });
    await write_log({
      project_id: null,
      ms_ago: 2 * HOUR_MS,
      body: 'boom',
      severity_text: 'ERROR',
      severity_number: 17,
      trace_id: 'log-trace',
      span_id: 'log-span',
      attributes: {
        'canyonos.agent.name': 'RiskAgent',
        'canyonos.agent.id': 'risk-0',
        'exception.type': 'ValueError',
      },
    });
    await write_log({
      project_id,
      ms_ago: 3 * HOUR_MS,
      body: 'fatal',
      severity_text: 'FATAL',
      attributes: { 'canyonos.agent.name': 'PriceAgent', 'canyonos.agent.id': 'price-1' },
    });
    await write_log({
      project_id,
      ms_ago: 4 * HOUR_MS,
      body: 'warn',
      severity_text: 'WARN',
      severity_number: 13,
      service_name: 'svc-a',
    });
    await write_log({ project_id, ms_ago: 5 * HOUR_MS, body: 'bare' });

    await write_log({ project_id: foreign_id, ms_ago: HOUR_MS, body: 'foreign' });
    await write_log({
      project_id: null,
      ms_ago: 1.5 * HOUR_MS,
      body: 'foreign trace',
      trace_id: 'log-foreign-trace',
    });
    await write_log({ project_id, ms_ago: 2 * DAY_MS, body: 'too old' });
  });

  const read_logs = (query: Partial<MonitoringLogsQuery>, id = project_id) =>
    api.projects[id]!.monitoring.logs.get({
      $headers: bearer(token),
      $query: { time_window: '1d', limit: 200, errors_only: false, ...query },
    });

  test('every log of the project, newest first, with promoted keys out of attributes', async () => {
    const res = await read_logs({});
    expect(res.error).toBeNull();

    expect(res.data).toEqual({
      project_id,
      time_window: '1d',
      logs: [
        {
          at: at_ago(HOUR_MS),
          severity: 'INFO',
          severity_number: 9,
          agent: 'PriceAgent',
          replica: 'price-0',
          body: 'hello',
          trace_id: null,
          span_id: null,
          attributes: { 'http.route': '/quote' },
        },
        {
          at: at_ago(2 * HOUR_MS),
          severity: 'ERROR',
          severity_number: 17,
          agent: 'RiskAgent',
          replica: 'risk-0',
          body: 'boom',
          trace_id: 'log-trace',
          span_id: 'log-span',
          attributes: { 'exception.type': 'ValueError' },
        },
        {
          at: at_ago(3 * HOUR_MS),
          severity: 'FATAL',
          severity_number: null,
          agent: 'PriceAgent',
          replica: 'price-1',
          body: 'fatal',
          trace_id: null,
          span_id: null,
          attributes: {},
        },
        {
          at: at_ago(4 * HOUR_MS),
          severity: 'WARN',
          severity_number: 13,
          agent: null,
          replica: 'svc-a',
          body: 'warn',
          trace_id: null,
          span_id: null,
          attributes: {},
        },
        {
          at: at_ago(5 * HOUR_MS),
          severity: null,
          severity_number: null,
          agent: null,
          replica: null,
          body: 'bare',
          trace_id: null,
          span_id: null,
          attributes: {},
        },
      ],
    });
  });

  test('limit keeps the newest records', async () => {
    const res = await read_logs({ limit: 2 });
    expect(res.data!.logs.map((log) => log.body)).toEqual(['hello', 'boom']);
  });

  test('errors_only keeps severity 17 and up or ERROR/FATAL text', async () => {
    const res = await read_logs({ errors_only: true });
    expect(res.data!.logs.map((log) => log.body)).toEqual(['boom', 'fatal']);
  });

  test('agent and replica filter on the resolved source', async () => {
    const by_agent = await read_logs({ agent: 'PriceAgent' });
    expect(by_agent.data!.logs.map((log) => log.body)).toEqual(['hello', 'fatal']);

    const by_replica = await read_logs({ agent: 'PriceAgent', replica: 'price-1' });
    expect(by_replica.data!.logs.map((log) => log.body)).toEqual(['fatal']);

    const by_service = await read_logs({ agent: 'svc-a' });
    expect(by_service.data!.logs.map((log) => log.body)).toEqual(['warn']);
  });

  test('the window bounds the records', async () => {
    const res = await read_logs({ time_window: '7d' });
    expect(res.data!.logs.map((log) => log.body)).toEqual([
      'hello',
      'boom',
      'fatal',
      'warn',
      'bare',
      'too old',
    ]);
  });

  test('the foreign project reads only its own logs', async () => {
    const res = await read_logs({}, foreign_id);
    expect(res.data!.logs.map((log) => log.body)).toEqual(['foreign', 'foreign trace']);
  });

  test('a project with no logs returns an empty list', async () => {
    const { project_id: empty_id } = await create_project(token, 'Empty Logs');
    const res = await read_logs({}, empty_id);
    expect(res.data).toEqual({ project_id: empty_id, time_window: '1d', logs: [] });
  });

  test('a limit outside 1..500 is rejected by validation (422)', async () => {
    expect((await read_logs({ limit: 501 })).error?.status as number).toBe(422);
    expect((await read_logs({ limit: 0 })).error?.status as number).toBe(422);
  });
});

describe('GET /projects/:project_id/monitoring/logs/sources', () => {
  test('agents with their replicas, both sorted, scoped, with an unknown fallback', async () => {
    const { project_id } = await create_project(token, 'Sources Project');
    const { project_id: foreign_id } = await create_project(token, 'Foreign Sources');
    const agent = (name: string, id: string) => ({
      'canyonos.agent.name': name,
      'canyonos.agent.id': id,
    });

    await write_log({ project_id, ms_ago: HOUR_MS, body: 'a', attributes: agent('Risk', 'r-0') });
    await write_log({ project_id, ms_ago: HOUR_MS, body: 'b', attributes: agent('Price', 'p-1') });
    await write_log({ project_id, ms_ago: HOUR_MS, body: 'c', attributes: agent('Price', 'p-0') });
    await write_log({ project_id, ms_ago: HOUR_MS, body: 'd', attributes: agent('Price', 'p-0') });
    await write_log({
      project_id,
      ms_ago: HOUR_MS,
      body: 'e',
      attributes: { 'canyonos.agent.id': 'solo-0' },
    });
    await write_log({ project_id, ms_ago: HOUR_MS, body: 'f', service_name: 'svc-a' });
    await write_log({ project_id, ms_ago: HOUR_MS, body: 'g' });
    await write_log({
      project_id: foreign_id,
      ms_ago: HOUR_MS,
      body: 'x',
      attributes: agent('Foreign', 'f-0'),
    });

    const res = await api.projects[project_id]!.monitoring.logs.sources.get({
      $headers: bearer(token),
      $query: { time_window: '1d' },
    });
    expect(res.error).toBeNull();
    expect(res.data).toEqual({
      project_id,
      time_window: '1d',
      sources: [
        { agent: 'Price', replicas: ['p-0', 'p-1'] },
        { agent: 'Risk', replicas: ['r-0'] },
        { agent: 'solo-0', replicas: ['solo-0'] },
        { agent: 'svc-a', replicas: ['svc-a'] },
        { agent: 'unknown', replicas: ['unknown'] },
      ],
    });
  });

  test('a project with no logs has no sources', async () => {
    const { project_id } = await create_project(token, 'Empty Sources');
    const res = await api.projects[project_id]!.monitoring.logs.sources.get({
      $headers: bearer(token),
      $query: { time_window: '7d' },
    });
    expect(res.data).toEqual({ project_id, time_window: '7d', sources: [] });
  });
});

describe('GET /projects/:project_id/monitoring/llm', () => {
  let project_id: string;

  const first_call_attributes = {
    [GEN_AI.REQUEST_MODEL]: 'gpt-x',
    [GEN_AI.AGENT_ID]: 'price-0',
    [GEN_AI.INPUT_TOKENS]: 100,
    [GEN_AI.OUTPUT_TOKENS]: 50,
    [GEN_AI.CACHE_READ_INPUT_TOKENS]: 50,
    [GEN_AI.USAGE_COST]: 0.002,
  };
  const second_call_attributes = { [GEN_AI.REQUEST_MODEL]: 'claude-y' };

  beforeAll(async () => {
    ({ project_id } = await create_project(token, 'LLM Project'));
    const { project_id: foreign_id } = await create_project(token, 'Foreign LLM');

    await write_span(project_id, {
      span_id: 'llm-1',
      trace_id: 'llm-trace-1',
      name: 'quote',
      ms_ago: HOUR_MS,
      duration_ms: 1500,
      attributes: first_call_attributes,
      input: 'price this',
      output: '42',
    });
    await write_span(project_id, {
      span_id: 'llm-2',
      trace_id: 'llm-trace-2',
      name: 'assess',
      ms_ago: 2 * HOUR_MS,
      duration_ms: 250,
      failed: true,
      status_message: 'rate limited',
      attributes: second_call_attributes,
    });
    await write_span(project_id, {
      span_id: 'llm-harness',
      trace_id: 'llm-trace-1',
      ms_ago: 0.5 * HOUR_MS,
      duration_ms: 10,
    });
    await write_span(foreign_id, {
      span_id: 'llm-foreign',
      trace_id: 'llm-foreign',
      ms_ago: HOUR_MS,
      duration_ms: 10,
      attributes: { [GEN_AI.REQUEST_MODEL]: 'gpt-x' },
    });
  });

  test('only model spans of the project, newest first, with usage mapped', async () => {
    const res = await api.projects[project_id]!.monitoring.llm.get({
      $headers: bearer(token),
      $query: { time_window: '1d', limit: 200 },
    });
    expect(res.error).toBeNull();
    expect(res.data).toEqual({
      project_id,
      time_window: '1d',
      calls: [
        {
          at: at_ago(HOUR_MS),
          name: 'quote',
          model: 'gpt-x',
          agent: 'price-0',
          duration_ms: 1500,
          input_tokens: 100,
          output_tokens: 50,
          cache_hit_ratio: 50 / 150,
          cost: 0.002,
          failed: false,
          status_message: null,
          trace_id: 'llm-trace-1',
          span_id: 'llm-1',
          input: 'price this',
          output: '42',
          attributes: { [PROJECT_ID_ATTRIBUTE]: project_id, ...first_call_attributes },
        },
        {
          at: at_ago(2 * HOUR_MS),
          name: 'assess',
          model: 'claude-y',
          agent: null,
          duration_ms: 250,
          input_tokens: null,
          output_tokens: null,
          cache_hit_ratio: null,
          cost: null,
          failed: true,
          status_message: 'rate limited',
          trace_id: 'llm-trace-2',
          span_id: 'llm-2',
          input: null,
          output: null,
          attributes: { [PROJECT_ID_ATTRIBUTE]: project_id, ...second_call_attributes },
        },
      ],
    });
  });

  test('limit keeps the newest calls', async () => {
    const res = await api.projects[project_id]!.monitoring.llm.get({
      $headers: bearer(token),
      $query: { time_window: '1d', limit: 1 },
    });
    expect(res.data!.calls.map((call) => call.span_id)).toEqual(['llm-1']);
  });

  test('a project with no model spans returns no calls', async () => {
    const { project_id: empty_id } = await create_project(token, 'Empty LLM');
    const res = await api.projects[empty_id]!.monitoring.llm.get({
      $headers: bearer(token),
      $query: { time_window: '1d', limit: 200 },
    });
    expect(res.data).toEqual({ project_id: empty_id, time_window: '1d', calls: [] });
  });
});

describe('GET /projects/:project_id/monitoring/traces', () => {
  let project_id: string;

  /**
   * `tr-a` (3h): root `handle` 4000ms with a failed `call-llm` at +1000ms and `fetch` at +2000ms.
   * `tr-c` (2h): one span. `tr-b` (1h): one span whose parent id is stored empty.
   */
  beforeAll(async () => {
    ({ project_id } = await create_project(token, 'Traces Project'));
    const { project_id: foreign_id } = await create_project(token, 'Foreign Traces');
    const agent = (id: string) => ({ [GEN_AI.AGENT_ID]: id });
    const start = 3 * HOUR_MS;

    await write_span(project_id, {
      span_id: 'tr-a-root',
      trace_id: 'tr-a',
      name: 'handle',
      ms_ago: start,
      duration_ms: 4000,
      attributes: agent('price-0'),
    });
    await write_span(project_id, {
      span_id: 'tr-a-llm',
      trace_id: 'tr-a',
      parent_span_id: 'tr-a-root',
      name: 'call-llm',
      ms_ago: start - 1000,
      duration_ms: 1000,
      failed: true,
      status_message: 'llm down',
      attributes: agent('risk-0'),
    });
    await write_span(project_id, {
      span_id: 'tr-a-fetch',
      trace_id: 'tr-a',
      parent_span_id: 'tr-a-root',
      name: 'fetch',
      ms_ago: start - 2000,
      duration_ms: 500,
      attributes: agent('price-0'),
    });
    await write_span(project_id, {
      span_id: 'tr-c',
      trace_id: 'tr-c',
      name: 'third',
      ms_ago: 2 * HOUR_MS,
      duration_ms: 300,
      attributes: agent('advisor-0'),
    });
    await write_span(project_id, {
      span_id: 'tr-b',
      trace_id: 'tr-b',
      parent_span_id: '',
      name: 'other',
      ms_ago: HOUR_MS,
      duration_ms: 200,
    });
    await write_span(foreign_id, {
      span_id: 'tr-foreign',
      trace_id: 'tr-foreign',
      ms_ago: 0.5 * HOUR_MS,
      duration_ms: 100,
    });
  });

  test('traces newest first, each with its spans in start order', async () => {
    const res = await api.projects[project_id]!.monitoring.traces.get({
      $headers: bearer(token),
      $query: { time_window: '1d', limit: 200 },
    });
    expect(res.error).toBeNull();
    expect(res.data).toEqual({
      project_id,
      time_window: '1d',
      traces: [
        {
          at: at_ago(HOUR_MS),
          trace_id: 'tr-b',
          name: 'other',
          agents: [],
          span_count: 1,
          duration_ms: 200,
          failed: false,
          spans: [
            {
              span_id: 'tr-b',
              parent_span_id: null,
              name: 'other',
              agent: null,
              offset_ms: 0,
              duration_ms: 200,
              failed: false,
              status_message: null,
            },
          ],
        },
        {
          at: at_ago(2 * HOUR_MS),
          trace_id: 'tr-c',
          name: 'third',
          agents: ['advisor-0'],
          span_count: 1,
          duration_ms: 300,
          failed: false,
          spans: [
            {
              span_id: 'tr-c',
              parent_span_id: null,
              name: 'third',
              agent: 'advisor-0',
              offset_ms: 0,
              duration_ms: 300,
              failed: false,
              status_message: null,
            },
          ],
        },
        {
          at: at_ago(3 * HOUR_MS),
          trace_id: 'tr-a',
          name: 'handle',
          agents: ['price-0', 'risk-0'],
          span_count: 3,
          duration_ms: 4000,
          failed: true,
          spans: [
            {
              span_id: 'tr-a-root',
              parent_span_id: null,
              name: 'handle',
              agent: 'price-0',
              offset_ms: 0,
              duration_ms: 4000,
              failed: false,
              status_message: null,
            },
            {
              span_id: 'tr-a-llm',
              parent_span_id: 'tr-a-root',
              name: 'call-llm',
              agent: 'risk-0',
              offset_ms: 1000,
              duration_ms: 1000,
              failed: true,
              status_message: 'llm down',
            },
            {
              span_id: 'tr-a-fetch',
              parent_span_id: 'tr-a-root',
              name: 'fetch',
              agent: 'price-0',
              offset_ms: 2000,
              duration_ms: 500,
              failed: false,
              status_message: null,
            },
          ],
        },
      ],
    });
  });

  test('limit counts traces, not spans', async () => {
    const res = await api.projects[project_id]!.monitoring.traces.get({
      $headers: bearer(token),
      $query: { time_window: '1d', limit: 1 },
    });
    expect(res.data!.traces.map((trace) => trace.trace_id)).toEqual(['tr-b']);

    const oldest = await api.projects[project_id]!.monitoring.traces.get({
      $headers: bearer(token),
      $query: { time_window: '1d', limit: 3 },
    });
    expect(oldest.data!.traces.at(-1)!.spans).toHaveLength(3);
  });

  test('a project with no spans returns no traces', async () => {
    const { project_id: empty_id } = await create_project(token, 'Empty Traces');
    const res = await api.projects[empty_id]!.monitoring.traces.get({
      $headers: bearer(token),
      $query: { time_window: '1d', limit: 200 },
    });
    expect(res.data).toEqual({ project_id: empty_id, time_window: '1d', traces: [] });
  });
});

describe('GET /projects/:project_id/monitoring/errors/summary', () => {
  const error_log = (
    project_id: string | null,
    body: string,
    attributes: Record<string, unknown>,
    severity: Pick<LogFixture, 'severity_text' | 'severity_number'> = { severity_number: 17 }
  ) => write_log({ project_id, ms_ago: HOUR_MS, body, attributes, ...severity });

  test('error logs grouped by exception type and by agent, both sorted', async () => {
    const { project_id } = await create_project(token, 'Errors Project');
    const { project_id: foreign_id } = await create_project(token, 'Foreign Errors');
    const price = { 'canyonos.agent.name': 'PriceAgent' };
    const risk = { 'canyonos.agent.id': 'risk-0' };

    for (const body of ['v1', 'v2', 'v3']) {
      await error_log(project_id, body, { ...price, 'exception.type': 'ValueError' });
    }
    await error_log(project_id, 'k', { ...risk, 'exception.type': 'KeyError' });
    await error_log(
      project_id,
      't',
      { ...risk, 'exception.type': 'TimeoutError' },
      { severity_text: 'FATAL' }
    );
    await error_log(project_id, 'u', {});
    await error_log(project_id, 'info', { 'exception.type': 'Ignored' }, { severity_number: 9 });
    await error_log(foreign_id, 'foreign', { 'exception.type': 'ForeignError' });

    const res = await api.projects[project_id]!.monitoring.errors.summary.get({
      $headers: bearer(token),
      $query: { time_window: '1d' },
    });
    expect(res.error).toBeNull();
    expect(res.data).toEqual({
      project_id,
      time_window: '1d',
      total: 6,
      by_type: [
        { key: 'ValueError', count: 3 },
        { key: 'KeyError', count: 1 },
        { key: 'TimeoutError', count: 1 },
        { key: 'Untyped', count: 1 },
      ],
      by_agent: [
        { key: 'PriceAgent', count: 3 },
        { key: 'risk-0', count: 2 },
        { key: 'unknown', count: 1 },
      ],
    });
  });

  test('each grouping is capped at ten groups while total counts every error', async () => {
    const { project_id } = await create_project(token, 'Many Errors');
    const types = Array.from({ length: 12 }, (_, i) => `E${String(i + 1).padStart(2, '0')}`);
    for (const type of types) await error_log(project_id, type, { 'exception.type': type });

    const res = await api.projects[project_id]!.monitoring.errors.summary.get({
      $headers: bearer(token),
      $query: { time_window: '1d' },
    });
    expect(res.data!.total).toBe(12);
    expect(res.data!.by_type).toEqual(types.slice(0, 10).map((key) => ({ key, count: 1 })));
    expect(res.data!.by_agent).toEqual([{ key: 'unknown', count: 12 }]);
  });

  test('a project with no errors returns an empty summary', async () => {
    const { project_id } = await create_project(token, 'No Errors');
    const res = await api.projects[project_id]!.monitoring.errors.summary.get({
      $headers: bearer(token),
      $query: { time_window: '1d' },
    });
    expect(res.data).toEqual({
      project_id,
      time_window: '1d',
      total: 0,
      by_type: [],
      by_agent: [],
    });
  });
});

describe('GET /projects/:project_id/monitoring/resources', () => {
  /**
   * Machines: `host-b` CPU 80 (1.5h); `host-a` CPU 20 (3.5h) and 40 (1.5h), memory 70 (1.5h);
   * `svc-m` (no host name) disk 10 (1.5h). Agents from span CPU: `risk-0` 50 (1.5h), `price-0` 25
   * (2.5h) and 35 (1.5h). The earliest reading is 3.5h ago, so the grid opens there.
   */
  test('machines and agents with their stats on a grid trimmed to the first reading', async () => {
    const { project_id } = await create_project(token, 'Resources Project');
    const { project_id: foreign_id } = await create_project(token, 'Foreign Resources');
    const { cpu, memory, disk } = MACHINE_UTILIZATION_METRICS;
    const first = 3.5 * HOUR_MS;
    const recent = 1.5 * HOUR_MS;
    const middle = 2.5 * HOUR_MS;

    await write_metric(project_id, { metric_name: cpu, ms_ago: first, value: 20, host: 'host-a' });
    await write_metric(project_id, { metric_name: cpu, ms_ago: recent, value: 40, host: 'host-a' });
    await write_metric(project_id, {
      metric_name: memory,
      ms_ago: recent,
      value: 70,
      host: 'host-a',
    });
    await write_metric(project_id, { metric_name: cpu, ms_ago: recent, value: 80, host: 'host-b' });
    await write_metric(project_id, {
      metric_name: disk,
      ms_ago: recent,
      value: 10,
      service_name: 'svc-m',
    });
    await write_metric(project_id, {
      metric_name: 'canyonos.machine.network.utilization',
      ms_ago: recent,
      value: 5,
      host: 'host-a',
    });
    await write_metric(foreign_id, { metric_name: cpu, ms_ago: 5 * HOUR_MS, value: 99 });

    const cpu_span = (span_id: string, agent_id: string, ms_ago: number, value: number) =>
      write_span(project_id, {
        span_id,
        trace_id: span_id,
        ms_ago,
        duration_ms: 10,
        attributes: { [GEN_AI.AGENT_ID]: agent_id, [RUNTIME_ATTRIBUTES.CPU_PERCENT]: value },
      });
    await cpu_span('res-price-1', 'price-0', middle, 25);
    await cpu_span('res-price-2', 'price-0', recent, 35);
    await cpu_span('res-risk-1', 'risk-0', recent, 50);
    await write_span(project_id, {
      span_id: 'res-no-cpu',
      trace_id: 'res-no-cpu',
      ms_ago: 5 * HOUR_MS,
      duration_ms: 10,
      attributes: { [GEN_AI.AGENT_ID]: 'idle-0' },
    });

    const res = await api.projects[project_id]!.monitoring.resources.get({
      $headers: bearer(token),
      $query: { time_window: '1d' },
    });
    expect(res.error).toBeNull();
    const grid = res.data!;
    const starts = grid.bucket_start_ats.map((start_at) => Date.parse(start_at));

    expect(bucket_of(grid, first)).toBe(0);
    expect(starts.at(-1)).toBe(Math.floor(Date.now() / HOUR_MS) * HOUR_MS);
    for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i - 1]!).toBe(HOUR_MS);

    const series = (
      resource: 'cpu' | 'memory' | 'disk',
      points: [number, number][],
      stats: { average: number; peak: number; latest: number; samples: number }
    ) => ({ resource, values: grid_values(grid, null, points), ...stats });

    expect(res.data).toEqual({
      project_id,
      time_window: '1d',
      bucket_seconds: SECONDS_PER_HOUR,
      bucket_start_ats: grid.bucket_start_ats,
      machines: [
        {
          key: 'host-b',
          series: [
            series('cpu', [[recent, 80]], { average: 80, peak: 80, latest: 80, samples: 1 }),
          ],
        },
        {
          key: 'host-a',
          series: [
            series(
              'cpu',
              [
                [first, 20],
                [recent, 40],
              ],
              { average: 30, peak: 40, latest: 40, samples: 2 }
            ),
            series('memory', [[recent, 70]], { average: 70, peak: 70, latest: 70, samples: 1 }),
          ],
        },
        {
          key: 'svc-m',
          series: [
            series('disk', [[recent, 10]], { average: 10, peak: 10, latest: 10, samples: 1 }),
          ],
        },
      ],
      agents: [
        {
          key: 'risk-0',
          series: [
            series('cpu', [[recent, 50]], { average: 50, peak: 50, latest: 50, samples: 1 }),
          ],
        },
        {
          key: 'price-0',
          series: [
            series(
              'cpu',
              [
                [middle, 25],
                [recent, 35],
              ],
              { average: 30, peak: 35, latest: 35, samples: 2 }
            ),
          ],
        },
      ],
    });
  });

  test('a project with no readings keeps the full grid', async () => {
    const { project_id } = await create_project(token, 'Empty Resources');
    for (const [time_window, buckets] of [
      ['1d', 24],
      ['7d', 30],
    ] as const) {
      const res = await api.projects[project_id]!.monitoring.resources.get({
        $headers: bearer(token),
        $query: { time_window },
      });
      expect(res.error).toBeNull();
      expect(res.data).toEqual({
        project_id,
        time_window,
        bucket_seconds: res.data!.bucket_seconds,
        bucket_start_ats: res.data!.bucket_start_ats,
        machines: [],
        agents: [],
      });
      expect(res.data!.bucket_start_ats).toHaveLength(buckets);
    }
  });
});

describe('monitoring access', () => {
  test('every monitoring route rejects a caller without a token and an unknown project', async () => {
    const { project_id } = await create_project(token, 'Access Monitoring');
    const unknown = '00000000-0000-4000-8000-000000000000';
    const routes = (id: string, headers: Record<string, string> = {}) => {
      const monitoring = api.projects[id]!.monitoring;
      const read = { $headers: headers, $query: { time_window: '1d' } as const };
      const list = { ...read, $query: { ...read.$query, limit: 200 } };
      return Promise.all([
        monitoring.series.get(read),
        monitoring.logs.get({ ...list, $query: { ...list.$query, errors_only: false } }),
        monitoring.logs.sources.get(read),
        monitoring.llm.get(list),
        monitoring.traces.get(list),
        monitoring.errors.summary.get(read),
        monitoring.resources.get(read),
      ]);
    };

    for (const res of await routes(project_id)) expect(res.error?.status as number).toBe(401);
    for (const res of await routes(unknown, bearer(token))) {
      expect(res.error?.status as number).toBe(404);
      expect((res.error?.value as { error?: string })?.error).toBe('projects.not_found');
    }
  });
});
