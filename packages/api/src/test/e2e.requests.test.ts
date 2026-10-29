// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, test } from 'bun:test';

import { api, setupE2ETests } from './e2e.setup';
import { authenticate, bearer, create_test_project } from './project-test.utils';
import { write_project_span, write_unattributed_span } from './telemetry-test.utils';
import type {
  RequestListItem,
  RequestSort,
  SortDirection,
} from '../modules/requests/requests.types';

setupE2ETests();

const VALID_REQUEST_ID = 'req_00000001';

async function create_project(token: string): Promise<string> {
  const { project_id } = await create_test_project(token, { name: 'Requests Project' });
  return project_id;
}

const NANOS_PER_MS = 1_000_000n;
const MINUTE_MS = 60 * 1000;

// One frozen reference: deriving each span from Date.now() at insert time would skew the fixtures
// by the milliseconds between inserts.
const BASE_MS = Date.now();
const BASE_NANOS = BigInt(BASE_MS) * NANOS_PER_MS;

const MONTH_MINUTES = 30 * 24 * 60;

const range = (minutes: number) => ({
  from: new Date(BASE_MS - minutes * MINUTE_MS).toISOString(),
  to: new Date(BASE_MS).toISOString(),
});

const ago = (ms: number): bigint => BASE_NANOS - BigInt(Math.round(ms)) * NANOS_PER_MS;
const plus = (nanos: bigint, ms: number): bigint => nanos + BigInt(Math.round(ms)) * NANOS_PER_MS;

interface SeededSpan {
  readonly span_id: string;
  readonly trace_id: string;
  readonly start_time_unix_nano: bigint;
  readonly end_time_unix_nano: bigint;
  readonly name?: string;
  readonly failed?: boolean;
  readonly model?: string;
  readonly prompt_name?: string;
  readonly prompt_version?: string;
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cost?: number;
  readonly token_cost?: number;
  readonly server_cost?: number;
  readonly error_count?: number;
  readonly input?: string;
  readonly output?: string;
}

async function seed(project_id: string, spans: readonly SeededSpan[]): Promise<void> {
  for (const span of spans) await write_project_span(project_id, span);
}

function listing_spans(prefix: string): SeededSpan[] {
  const done_start = ago(10 * MINUTE_MS);
  return [
    {
      span_id: `${prefix}-recent-1`,
      trace_id: `${prefix}-recent`,
      name: 'chat',
      start_time_unix_nano: ago(5 * MINUTE_MS),
      end_time_unix_nano: plus(ago(5 * MINUTE_MS), 1000),
      model: 'gpt-4',
      input_tokens: 10,
      output_tokens: 5,
      cost: 0.00005,
      token_cost: 0.00005,
      input: '{"prompt":"recent"}',
      output: 'plain recent answer',
    },
    {
      span_id: `${prefix}-done-1`,
      trace_id: `${prefix}-done`,
      name: 'plan',
      start_time_unix_nano: done_start,
      end_time_unix_nano: plus(done_start, 1000),
      model: 'claude-sonnet',
      prompt_name: 'Planner.plan',
      prompt_version: 'Planner-plan-0a1b2c3d-v2',
      input_tokens: 60,
      output_tokens: 40,
      cost: 0.0003,
      token_cost: 0.0003,
      input: '{"prompt":"done"}',
    },
    {
      span_id: `${prefix}-done-2`,
      trace_id: `${prefix}-done`,
      name: 'retrieve',
      start_time_unix_nano: plus(done_start, 2000),
      end_time_unix_nano: plus(done_start, 5000),
      cost: 0.00003,
      server_cost: 0.00003,
      error_count: 1,
      output: '{"result":"done"}',
    },
    {
      span_id: `${prefix}-failed-1`,
      trace_id: `${prefix}-failed`,
      name: 'tool',
      start_time_unix_nano: ago(20 * MINUTE_MS),
      end_time_unix_nano: plus(ago(20 * MINUTE_MS), 500),
      failed: true,
      cost: 0.00003,
      server_cost: 0.00003,
    },
    {
      span_id: `${prefix}-old-1`,
      trace_id: `${prefix}-old`,
      name: 'chat',
      start_time_unix_nano: ago(30 * MINUTE_MS),
      end_time_unix_nano: plus(ago(30 * MINUTE_MS), 200),
      model: 'gpt-4',
      input_tokens: 5,
      output_tokens: 5,
      cost: 0.00001,
      token_cost: 0.00001,
    },
  ];
}

type ListQuery = Record<string, string | number | undefined>;

async function list(token: string, project_id: string, query: ListQuery = {}) {
  const res = await api.projects[project_id]!.requests.get({
    $query: { ...range(60), limit: 20, offset: 0, ...query },
    $headers: bearer(token),
  });
  expect(res.error).toBeNull();
  return res.data!;
}

const ids = (items: readonly RequestListItem[]): string[] => items.map((item) => item.session_id);

describe('request trace endpoint', () => {
  test('the owner gets 404 when an owned project has no matching request', async () => {
    const token = await authenticate('req-owner@canyonos.test');
    const project_id = await create_project(token);

    const res = await api.projects[project_id]!.requests[VALID_REQUEST_ID]!.get({
      $query: range(MONTH_MINUTES),
      $headers: bearer(token),
    });

    expect(res.error?.status as number).toBe(404);
    expect((res.error?.value as { error?: string })?.error).toBe('requests.not_found');
  });

  test('an unknown project id is 404 projects.not_found, not requests.not_found', async () => {
    const token = await authenticate('req-owner2@canyonos.test');
    const unknown = '00000000-0000-4000-8000-000000000000';

    const res = await api.projects[unknown]!.requests[VALID_REQUEST_ID]!.get({
      $query: range(MONTH_MINUTES),
      $headers: bearer(token),
    });

    expect(res.error?.status as number).toBe(404);
    expect((res.error?.value as { error?: string })?.error).toBe('projects.not_found');
  });

  test('a request without a token is rejected with 401', async () => {
    const owner = await authenticate('req-owner3@canyonos.test');
    const project_id = await create_project(owner);

    const res = await api.projects[project_id]!.requests[VALID_REQUEST_ID]!.get({
      $query: range(MONTH_MINUTES),
    });
    expect(res.error?.status as number).toBe(401);
  });

  test('a trace read without from/to is rejected by validation (422)', async () => {
    const token = await authenticate('req-norange@canyonos.test');
    const project_id = await create_project(token);

    const res = await api.projects[project_id]!.requests[VALID_REQUEST_ID]!.get({
      $headers: bearer(token),
    } as never);
    expect(res.error?.status as number).toBe(422);
  });

  test('an oversized request id is rejected by validation (422)', async () => {
    const token = await authenticate('req-badreq@canyonos.test');
    const project_id = await create_project(token);

    const res = await api.projects[project_id]!.requests['x'.repeat(256)]!.get({
      $query: range(MONTH_MINUTES),
      $headers: bearer(token),
    });
    expect(res.error?.status as number).toBe(422);
  });

  test('a non-uuid project id is rejected by validation (422)', async () => {
    const token = await authenticate('req-baduuid@canyonos.test');
    const res = await api.projects['not-a-uuid']!.requests[VALID_REQUEST_ID]!.get({
      $query: range(MONTH_MINUTES),
      $headers: bearer(token),
    });
    expect(res.error?.status as number).toBe(422);
  });
});

describe('GET /projects/:project_id/requests (listing with rollups)', () => {
  test('lists requests newest-first with status, duration, token, and cost rollups', async () => {
    const token = await authenticate('req-list@canyonos.test');
    const project_id = await create_project(token);
    await seed(project_id, listing_spans('list'));

    const page = await list(token, project_id);

    expect(page.total).toBe(4);
    expect(ids(page.items)).toEqual(['list-recent', 'list-done', 'list-failed', 'list-old']);

    const done = page.items[1]!;
    expect(done).toMatchObject({
      session_id: 'list-done',
      status: 'completed',
      duration_ms: 5000,
      block_count: 2,
      failed_block_count: 0,
      error_count: 1,
      token_count: 100,
      llm_cost: '0.0003000000',
      harness_cost: '0.0000300000',
      total_cost: '0.0003300000',
    });

    const failed = page.items[2]!;
    expect(failed).toMatchObject({
      status: 'failed',
      block_count: 1,
      failed_block_count: 1,
      duration_ms: 500,
      token_count: 0,
      total_cost: '0.0000300000',
    });
  });

  test('every request reports a finish time and a duration', async () => {
    const token = await authenticate('req-finished@canyonos.test');
    const project_id = await create_project(token);
    await seed(project_id, listing_spans('fin'));

    const page = await list(token, project_id);

    for (const item of page.items) {
      expect(item.started_at).not.toBeNull();
      expect(item.finished_at).not.toBeNull();
      expect(item.duration_ms).not.toBeNull();
      expect(Date.parse(item.finished_at!)).toBeGreaterThanOrEqual(Date.parse(item.started_at!));
    }
  });

  test('paginates with a stable total', async () => {
    const token = await authenticate('req-page@canyonos.test');
    const project_id = await create_project(token);
    await seed(project_id, listing_spans('page'));

    const first = await list(token, project_id, { limit: 2, offset: 0 });
    const second = await list(token, project_id, { limit: 2, offset: 2 });

    expect(first.total).toBe(4);
    expect(second.total).toBe(4);
    expect(ids(first.items)).toEqual(['page-recent', 'page-done']);
    expect(ids(second.items)).toEqual(['page-failed', 'page-old']);
  });

  test('filters by status and counts the same filtered set', async () => {
    const token = await authenticate('req-status@canyonos.test');
    const project_id = await create_project(token);
    await seed(project_id, listing_spans('st'));

    const failed = await list(token, project_id, { status: 'failed' });
    expect(failed.total).toBe(1);
    expect(ids(failed.items)).toEqual(['st-failed']);

    const completed = await list(token, project_id, { status: 'completed' });
    expect(completed.total).toBe(3);
    expect(ids(completed.items)).toEqual(['st-recent', 'st-done', 'st-old']);
  });

  test('the running filter lists nothing, because a stored span has always finished', async () => {
    const token = await authenticate('req-running@canyonos.test');
    const project_id = await create_project(token);
    await seed(project_id, listing_spans('run'));

    const running = await list(token, project_id, { status: 'running' });

    expect(running.total).toBe(0);
    expect(running.items).toEqual([]);
  });

  test('an empty project lists zero requests', async () => {
    const token = await authenticate('req-empty@canyonos.test');
    const project_id = await create_project(token);

    const page = await list(token, project_id);

    expect(page).toEqual({ ...range(60), total: 0, items: [] });
  });

  test('a span without the project attribute is invisible to every project', async () => {
    const token = await authenticate('req-orphan@canyonos.test');
    const project_id = await create_project(token);
    await seed(project_id, listing_spans('orph'));
    await write_unattributed_span({
      span_id: 'orph-loose-1',
      trace_id: 'orph-loose',
      start_time_unix_nano: ago(MINUTE_MS),
      end_time_unix_nano: plus(ago(MINUTE_MS), 100),
      cost: 9.999,
    });

    const page = await list(token, project_id);

    expect(page.total).toBe(4);
    expect(ids(page.items)).not.toContain('orph-loose');
  });

  test("another project's spans stay invisible even under the same trace id", async () => {
    const owner = await authenticate('req-shared-trace@canyonos.test');
    const mine = await create_project(owner);
    const theirs = await create_project(owner);
    const start = ago(MINUTE_MS);

    await write_project_span(mine, {
      span_id: 'shared-mine-1',
      trace_id: 'shared-trace',
      start_time_unix_nano: start,
      end_time_unix_nano: plus(start, 100),
      cost: 0.000011,
    });
    await write_project_span(theirs, {
      span_id: 'shared-theirs-1',
      trace_id: 'shared-trace',
      start_time_unix_nano: start,
      end_time_unix_nano: plus(start, 900),
      cost: 0.000099,
    });

    const page = await list(owner, mine);

    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({
      session_id: 'shared-trace',
      block_count: 1,
      duration_ms: 100,
      total_cost: '0.0000110000',
    });
  });

  test('an unselected range includes only requests with in-range spans', async () => {
    const token = await authenticate('req-window@canyonos.test');
    const project_id = await create_project(token);
    const old_start = ago(3 * 24 * 60 * MINUTE_MS);
    await seed(project_id, [
      ...listing_spans('win'),
      {
        span_id: 'win-ancient-1',
        trace_id: 'win-ancient',
        start_time_unix_nano: old_start,
        end_time_unix_nano: plus(old_start, 100),
        cost: 0.000001,
      },
    ]);

    const week = await list(token, project_id, { ...range(7 * 1440) });
    const day = await list(token, project_id, { ...range(1440) });

    expect(week.total).toBe(5);
    expect(ids(week.items)).toContain('win-ancient');
    expect(day.total).toBe(4);
    expect(ids(day.items)).not.toContain('win-ancient');
  });

  test("another user reads the project's requests", async () => {
    const owner = await authenticate('req-list-owner@canyonos.test');
    const project_id = await create_project(owner);
    await seed(project_id, listing_spans('guard'));

    const other_user = await authenticate('req-list-intruder@canyonos.test');
    const res = await api.projects[project_id]!.requests.get({
      $query: { ...range(60), limit: 20, offset: 0 },
      $headers: bearer(other_user),
    });

    expect(res.error).toBeNull();
    expect(res.data!.total).toBeGreaterThan(0);
  });

  test('a listing without a token is rejected with 401', async () => {
    const owner = await authenticate('req-list-anon@canyonos.test');
    const project_id = await create_project(owner);

    const res = await api.projects[project_id]!.requests.get({
      $query: { ...range(60), limit: 20, offset: 0 },
    });
    expect(res.error?.status as number).toBe(401);
  });

  test('an out-of-range limit is rejected by validation (422)', async () => {
    const token = await authenticate('req-limit@canyonos.test');
    const project_id = await create_project(token);

    const res = await api.projects[project_id]!.requests.get({
      $query: { ...range(60), limit: 500, offset: 0 },
      $headers: bearer(token),
    });
    expect(res.error?.status as number).toBe(422);
  });
});

describe('GET /projects/:project_id/requests (ordering)', () => {
  let token: string;
  let project_id: string;

  const ordered = async (sort: RequestSort, order: SortDirection): Promise<string[]> =>
    ids((await list(token, project_id, { sort, order })).items);

  beforeEach(async () => {
    token = await authenticate(`req-order-${Bun.randomUUIDv7()}@canyonos.test`);
    project_id = await create_project(token);
    await seed(project_id, listing_spans(`ord-${project_id.slice(0, 8)}`));
  });

  const local = (suffix: string): string => `ord-${project_id.slice(0, 8)}-${suffix}`;

  test('omitting sort and order keeps the listing newest-first', async () => {
    const page = await list(token, project_id);
    expect(ids(page.items)).toEqual([
      local('recent'),
      local('done'),
      local('failed'),
      local('old'),
    ]);
  });

  test('created_at ascending lists the oldest request first', async () => {
    expect(await ordered('created_at', 'asc')).toEqual([
      local('old'),
      local('failed'),
      local('done'),
      local('recent'),
    ]);
  });

  test('total_cost descending puts the most expensive request first', async () => {
    expect(await ordered('total_cost', 'desc')).toEqual([
      local('done'),
      local('recent'),
      local('failed'),
      local('old'),
    ]);
  });

  test('total_cost ascending reverses the ranked side', async () => {
    expect(await ordered('total_cost', 'asc')).toEqual([
      local('old'),
      local('failed'),
      local('recent'),
      local('done'),
    ]);
  });

  test('token_count descending puts the heaviest request first', async () => {
    expect(await ordered('token_count', 'desc')).toEqual([
      local('done'),
      local('recent'),
      local('old'),
      local('failed'),
    ]);
  });

  test('error_count descending puts the most-retried request first, then newest', async () => {
    expect(await ordered('error_count', 'desc')).toEqual([
      local('done'),
      local('recent'),
      local('failed'),
      local('old'),
    ]);
  });

  test('duration orders by the span window each request spans', async () => {
    expect(await ordered('duration_ms', 'desc')).toEqual([
      local('done'),
      local('recent'),
      local('failed'),
      local('old'),
    ]);
    expect(await ordered('duration_ms', 'asc')).toEqual([
      local('old'),
      local('failed'),
      local('recent'),
      local('done'),
    ]);
  });

  test('cost is ordered as money, not as the string it renders to', async () => {
    const big = ago(MINUTE_MS);
    await write_project_span(project_id, {
      span_id: local('big-1'),
      trace_id: local('big'),
      start_time_unix_nano: big,
      end_time_unix_nano: plus(big, 10),
      cost: 0.0009,
    });

    const [first] = await ordered('total_cost', 'desc');
    expect(first).toBe(local('big'));
  });

  test('paging a sorted listing never repeats or skips a request', async () => {
    const first = await list(token, project_id, { sort: 'total_cost', order: 'desc', limit: 2 });
    const second = await list(token, project_id, {
      sort: 'total_cost',
      order: 'desc',
      limit: 2,
      offset: 2,
    });

    const seen = [...ids(first.items), ...ids(second.items)];
    expect(new Set(seen).size).toBe(4);
    expect(seen).toEqual([local('done'), local('recent'), local('failed'), local('old')]);
  });

  test('an unknown sort key is rejected by validation (422)', async () => {
    const res = await api.projects[project_id]!.requests.get({
      $query: { ...range(60), limit: 20, offset: 0, sort: 'nonsense' as RequestSort },
      $headers: bearer(token),
    });
    expect(res.error?.status as number).toBe(422);
  });

  test('an unknown order direction is rejected by validation (422)', async () => {
    const res = await api.projects[project_id]!.requests.get({
      $query: {
        ...range(60),
        limit: 20,
        offset: 0,
        sort: 'total_cost',
        order: 'sideways' as SortDirection,
      },
      $headers: bearer(token),
    });
    expect(res.error?.status as number).toBe(422);
  });
});

describe('GET /projects/:project_id/requests (metric-range filtering)', () => {
  let token: string;
  let project_id: string;
  let prefix: string;

  // Four requests whose costs and tokens rise in equal steps, so a range picks a known subset.
  beforeEach(async () => {
    token = await authenticate(`req-range-${Bun.randomUUIDv7()}@canyonos.test`);
    project_id = await create_project(token);
    prefix = `rng-${project_id.slice(0, 8)}`;
    const steps = [1, 2, 3, 4];
    for (const step of steps) {
      const start = ago(step * MINUTE_MS);
      await write_project_span(project_id, {
        span_id: `${prefix}-${step}-1`,
        trace_id: `${prefix}-${step}`,
        start_time_unix_nano: start,
        end_time_unix_nano: plus(start, step * 100),
        model: 'gpt-4',
        input_tokens: step * 10,
        output_tokens: 0,
        cost: step * 0.001,
        token_cost: step * 0.001,
      });
    }
  });

  const ranged = async (metric: string, min: number, max: number): Promise<string[]> =>
    ids((await list(token, project_id, { metric, min, max, ...range(43200) })).items);

  test('cost_per_request lists only the requests inside the range', async () => {
    expect(await ranged('cost_per_request', 0.0015, 0.0035)).toEqual([
      `${prefix}-2`,
      `${prefix}-3`,
    ]);
  });

  test('tokens_per_request lists only the requests inside the range', async () => {
    expect(await ranged('tokens_per_request', 15, 35)).toEqual([`${prefix}-2`, `${prefix}-3`]);
  });

  test('latency lists only the requests inside the range', async () => {
    expect(await ranged('latency', 150, 350)).toEqual([`${prefix}-2`, `${prefix}-3`]);
  });

  test('a bucket lists its requests newest first, not the newest overall', async () => {
    expect(await ranged('cost_per_request', 0.0025, 0.0045)).toEqual([
      `${prefix}-3`,
      `${prefix}-4`,
    ]);
  });

  test('the top bucket includes its upper bound, so the largest request is reachable', async () => {
    expect(await ranged('cost_per_request', 0.0035, 0.004)).toEqual([`${prefix}-4`]);
  });

  test('a bound below the maximum excludes the value that equals it', async () => {
    expect(await ranged('cost_per_request', 0.001, 0.002)).toEqual([`${prefix}-1`]);
  });

  test('a range no request falls in lists nothing', async () => {
    expect(await ranged('cost_per_request', 9, 10)).toEqual([]);
  });

  test('a request that priced nothing is absent from a cost range', async () => {
    const start = ago(30 * 1000);
    await write_project_span(project_id, {
      span_id: `${prefix}-free-1`,
      trace_id: `${prefix}-free`,
      start_time_unix_nano: start,
      end_time_unix_nano: plus(start, 100),
    });

    expect(await ranged('cost_per_request', 0, 10)).not.toContain(`${prefix}-free`);
  });

  test('total counts the filtered set, not the whole project', async () => {
    const page = await list(token, project_id, {
      metric: 'cost_per_request',
      min: 0.0015,
      max: 0.0035,
      ...range(43200),
    });

    expect(page.total).toBe(2);
    expect(page.items).toHaveLength(2);
  });

  test('an order composes with a range instead of replacing it', async () => {
    const page = await list(token, project_id, {
      metric: 'cost_per_request',
      min: 0.0015,
      max: 0.0035,
      ...range(43200),
      sort: 'total_cost',
      order: 'desc',
    });

    expect(ids(page.items)).toEqual([`${prefix}-3`, `${prefix}-2`]);
  });

  test('a half-specified selection is rejected by validation (422)', async () => {
    const res = await api.projects[project_id]!.requests.get({
      $query: { ...range(60), limit: 20, offset: 0, metric: 'cost_per_request', min: 1 },
      $headers: bearer(token),
    });
    expect(res.error?.status as number).toBe(422);
  });

  test('an unknown metric is rejected by validation (422)', async () => {
    const res = await api.projects[project_id]!.requests.get({
      // @ts-expect-error deliberately invalid metric
      $query: { limit: 20, offset: 0, metric: 'vibes', min: 0, max: 1 },
      $headers: bearer(token),
    });
    expect(res.error?.status as number).toBe(422);
  });
});

describe('GET /projects/:project_id/requests (time-range filtering)', () => {
  test('a request is listed and counted whole in the range it started in', async () => {
    const token = await authenticate('req-whole@canyonos.test');
    const project_id = await create_project(token);
    const to_ms = BASE_MS - 30 * MINUTE_MS;
    const query = {
      from: new Date(to_ms - 60 * MINUTE_MS).toISOString(),
      to: new Date(to_ms).toISOString(),
    };
    const before_to = (minutes: number) => BigInt(to_ms - minutes * MINUTE_MS) * NANOS_PER_MS;
    await seed(project_id, [
      // Starts inside the range and finishes after it ends.
      {
        span_id: 'whole-1',
        trace_id: 'whole',
        start_time_unix_nano: before_to(1),
        end_time_unix_nano: before_to(0.5),
        cost: 0.001,
      },
      {
        span_id: 'whole-2',
        trace_id: 'whole',
        start_time_unix_nano: before_to(-2),
        end_time_unix_nano: before_to(-3),
        cost: 0.002,
      },
      // Started before the range, with a later step inside it.
      {
        span_id: 'earlier-1',
        trace_id: 'earlier',
        start_time_unix_nano: before_to(61),
        end_time_unix_nano: before_to(60.5),
        cost: 0.001,
      },
      {
        span_id: 'earlier-2',
        trace_id: 'earlier',
        start_time_unix_nano: before_to(30),
        end_time_unix_nano: before_to(29),
        cost: 0.001,
      },
    ]);

    const page = await list(token, project_id, query);
    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({
      session_id: 'whole',
      block_count: 2,
      duration_ms: 4 * MINUTE_MS,
      total_cost: '0.0030000000',
    });

    const traces = await api.projects[project_id]!.monitoring.traces.get({
      $query: { ...query, limit: 200 },
      $headers: bearer(token),
    });
    expect(traces.error).toBeNull();
    expect(
      traces.data!.traces.map(({ trace_id, span_count }) => ({ trace_id, span_count }))
    ).toEqual([{ trace_id: 'whole', span_count: 2 }]);

    const [kpis, timeseries, blocks, monitoring] = await Promise.all([
      api.projects[project_id]!.metrics.kpis.get({ $query: query, $headers: bearer(token) }),
      api.projects[project_id]!.metrics.timeseries.get({ $query: query, $headers: bearer(token) }),
      api.projects[project_id]!.metrics.blocks.get({ $query: query, $headers: bearer(token) }),
      api.projects[project_id]!.monitoring.series.get({ $query: query, $headers: bearer(token) }),
    ]);
    expect(kpis.data).toMatchObject({
      request_count: 1,
      block_count: 2,
      total_cost: '0.0030000000',
    });
    const points = timeseries.data!.points;
    expect(points.reduce((sum, point) => sum + point.request_count, 0)).toBe(1);
    expect(points.reduce((sum, point) => sum + Number(point.total_cost), 0).toFixed(10)).toBe(
      '0.0030000000'
    );
    expect(blocks.data!.total_cost).toBe('0.0030000000');
    const traffic = monitoring.data!.series.find((series) => series.signal === 'traffic')!;
    expect(traffic.values.reduce((sum: number, value) => sum + (value ?? 0), 0)).toBe(1);
  });

  let token: string;
  let project_id: string;
  let prefix: string;
  let day_start: string;
  let day_end: string;

  beforeEach(async () => {
    token = await authenticate(`req-day-${Bun.randomUUIDv7()}@canyonos.test`);
    project_id = await create_project(token);
    prefix = `day-${project_id.slice(0, 8)}`;

    const now = new Date();
    const start_of_day = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    );
    day_start = start_of_day.toISOString();
    day_end = new Date(start_of_day.getTime() + 24 * 60 * MINUTE_MS).toISOString();

    const inside = BigInt(start_of_day.getTime() + 60 * MINUTE_MS) * NANOS_PER_MS;
    const before = BigInt(start_of_day.getTime() - 60 * MINUTE_MS) * NANOS_PER_MS;

    await write_project_span(project_id, {
      span_id: `${prefix}-inside-1`,
      trace_id: `${prefix}-inside`,
      start_time_unix_nano: inside,
      end_time_unix_nano: plus(inside, 100),
      failed: true,
    });
    await write_project_span(project_id, {
      span_id: `${prefix}-edge-1`,
      trace_id: `${prefix}-edge`,
      start_time_unix_nano: BigInt(start_of_day.getTime()) * NANOS_PER_MS,
      end_time_unix_nano: plus(BigInt(start_of_day.getTime()) * NANOS_PER_MS, 100),
    });
    await write_project_span(project_id, {
      span_id: `${prefix}-before-1`,
      trace_id: `${prefix}-before`,
      start_time_unix_nano: before,
      end_time_unix_nano: plus(before, 100),
    });
  });

  test('a day window includes its start and excludes its end', async () => {
    const page = await list(token, project_id, {
      from: day_start,
      to: day_end,
    });

    expect(ids(page.items).sort()).toEqual([`${prefix}-edge`, `${prefix}-inside`].sort());
    expect(page.total).toBe(2);
  });

  test('a day window narrows a status filter instead of replacing it', async () => {
    const page = await list(token, project_id, {
      from: day_start,
      to: day_end,
      status: 'failed',
    });

    expect(ids(page.items)).toEqual([`${prefix}-inside`]);
  });

  test('a day with no requests lists nothing', async () => {
    const empty_from = new Date(Date.parse(day_start) - 30 * 24 * 60 * MINUTE_MS).toISOString();
    const empty_to = new Date(Date.parse(empty_from) + 24 * 60 * MINUTE_MS).toISOString();

    const page = await list(token, project_id, { from: empty_from, to: empty_to });

    expect(page).toEqual({ from: empty_from, to: empty_to, total: 0, items: [] });
  });

  test('a picked day narrows the range instead of replacing it', async () => {
    const page = await list(token, project_id, {
      from: new Date(Date.parse(day_start) + 30 * MINUTE_MS).toISOString(),
      to: day_end,
      created_from: day_start,
      created_to: day_end,
    });

    expect(ids(page.items)).toEqual([`${prefix}-inside`]);
    expect(page.total).toBe(1);
  });

  test('a picked day keeps a cost bucket measured over the whole range', async () => {
    const at = (minutes: number) =>
      BigInt(Date.parse(day_start) + minutes * MINUTE_MS) * NANOS_PER_MS;
    // The day's only priced request sits on the bucket's upper edge; the range's largest is outside the day.
    await seed(project_id, [
      {
        span_id: `${prefix}-small-1`,
        trace_id: `${prefix}-small`,
        start_time_unix_nano: at(120),
        end_time_unix_nano: at(121),
        cost: 1,
      },
      {
        span_id: `${prefix}-large-1`,
        trace_id: `${prefix}-large`,
        start_time_unix_nano: at(-120),
        end_time_unix_nano: at(-119),
        cost: 2,
      },
    ]);

    const page = await list(token, project_id, {
      from: new Date(Date.parse(day_start) - 180 * MINUTE_MS).toISOString(),
      to: day_end,
      created_from: day_start,
      created_to: day_end,
      metric: 'cost_per_request',
      min: 0,
      max: 1,
    });

    expect(page.total).toBe(0);
  });

  test('a day that ends before it starts is rejected by validation (422)', async () => {
    const res = await api.projects[project_id]!.requests.get({
      $query: {
        limit: 20,
        offset: 0,
        from: day_start,
        to: day_end,
        created_from: day_end,
        created_to: day_start,
      },
      $headers: bearer(token),
    });
    expect(res.error?.status as number).toBe(422);
  });

  test('a window that ends before it starts is rejected by validation (422)', async () => {
    const res = await api.projects[project_id]!.requests.get({
      $query: { limit: 20, offset: 0, from: day_end, to: day_start },
      $headers: bearer(token),
    });
    expect(res.error?.status as number).toBe(422);
  });

  test('a bound that is not an instant is rejected by validation (422)', async () => {
    const res = await api.projects[project_id]!.requests.get({
      $query: { limit: 20, offset: 0, from: '2026-09-01T00:00:00', to: day_end },
      $headers: bearer(token),
    });
    expect(res.error?.status as number).toBe(422);
  });
});

describe('GET /projects/:project_id/requests/:request_id', () => {
  test('returns one request trace with ordered blocks and the project median', async () => {
    const token = await authenticate('req-trace@canyonos.test');
    const project_id = await create_project(token);
    await seed(project_id, listing_spans('tr'));

    const res = await api.projects[project_id]!.requests['tr-done']!.get({
      $query: range(MONTH_MINUTES),
      $headers: bearer(token),
    });
    expect(res.error).toBeNull();
    const trace = res.data!;

    expect(trace).toMatchObject({
      project_id,
      session_id: 'tr-done',
      status: 'completed',
      duration_ms: 5000,
      error_count: 1,
      token_count: 100,
      total_cost: '0.0003300000',
      harness_cost: '0.0000300000',
    });
    expect(trace.input).toEqual({ prompt: 'done' });
    expect(trace.output).toEqual({ result: 'done' });
    expect(trace.median_cost).not.toBeNull();

    expect(trace.blocks.map((block) => block.future_id)).toEqual(['tr-done-1', 'tr-done-2']);
    expect(trace.blocks[0]).toMatchObject({
      label: 'plan',
      kind: 'model',
      model: 'claude-sonnet',
      prompt_name: 'Planner.plan',
      prompt_version: 'Planner-plan-0a1b2c3d-v2',
      started_offset_ms: 0,
      execution_time_ms: 1000,
      input_token_count: 60,
      output_token_count: 40,
      errors: 0,
      failed: false,
    });
    expect(trace.blocks[1]).toMatchObject({
      label: 'retrieve',
      kind: 'harness',
      model: null,
      prompt_name: null,
      prompt_version: null,
      started_offset_ms: 2000,
      execution_time_ms: 3000,
      errors: 1,
    });
  });

  test('a failed span makes the whole request failed', async () => {
    const token = await authenticate('req-trace-failed@canyonos.test');
    const project_id = await create_project(token);
    await seed(project_id, listing_spans('trf'));

    const res = await api.projects[project_id]!.requests['trf-failed']!.get({
      $query: range(MONTH_MINUTES),
      $headers: bearer(token),
    });

    expect(res.data?.status).toBe('failed');
    expect(res.data?.blocks[0]?.failed).toBe(true);
  });

  test('a refused step carries its error name and message; a successful one carries null', async () => {
    const token = await authenticate('req-trace-refused@canyonos.test');
    const project_id = await create_project(token);
    const message = 'MergeAgent requires TestRunnerAgent, which has no healthy replica right now.';
    const start = ago(5 * MINUTE_MS);
    await write_project_span(project_id, {
      span_id: 'refused-1',
      trace_id: 'refused',
      name: 'MergeAgent.merge',
      start_time_unix_nano: start,
      end_time_unix_nano: plus(start, 10),
      failed: true,
      status_message: message,
      events: [
        {
          time_unix_nano: String(plus(start, 10)),
          name: 'exception',
          attributes: { 'exception.message': message, 'exception.type': 'DependencyDown' },
        },
      ],
    });
    await write_project_span(project_id, {
      span_id: 'refused-2',
      trace_id: 'refused',
      name: 'Planner.plan',
      start_time_unix_nano: plus(start, 100),
      end_time_unix_nano: plus(start, 200),
    });

    const res = await api.projects[project_id]!.requests['refused']!.get({
      $query: range(MONTH_MINUTES),
      $headers: bearer(token),
    });
    expect(res.error).toBeNull();

    expect(res.data!.blocks[0]).toMatchObject({
      failed: true,
      error_name: 'DependencyDown',
      error_message: message,
    });
    expect(res.data!.blocks[1]).toMatchObject({
      failed: false,
      error_name: null,
      error_message: null,
    });
  });

  test('a payload that is not JSON is preserved as the text it was', async () => {
    const token = await authenticate('req-trace-text@canyonos.test');
    const project_id = await create_project(token);
    await seed(project_id, listing_spans('trt'));

    const res = await api.projects[project_id]!.requests['trt-recent']!.get({
      $query: range(MONTH_MINUTES),
      $headers: bearer(token),
    });

    expect(res.data?.input).toEqual({ prompt: 'recent' });
    expect(res.data?.output).toBe('plain recent answer');
  });

  test('the median reads only requests that billed inside the queried range', async () => {
    const token = await authenticate('req-median@canyonos.test');
    const project_id = await create_project(token);

    // Billed in the last 30 days: 0.001, 0.002, 0.003 -> median 0.002. Counting the two unbilled
    // requests as $0 would drag it to 0.001; a range reaching the 40-day-old $9 request moves it.
    for (const [index, cost] of [0.001, 0.002, 0.003].entries()) {
      const start = ago((index + 1) * MINUTE_MS);
      await write_project_span(project_id, {
        span_id: `med-billed-${index}`,
        trace_id: `med-billed-${index}`,
        start_time_unix_nano: start,
        end_time_unix_nano: plus(start, 100),
        cost,
      });
    }
    for (const index of [0, 1]) {
      const start = ago((index + 10) * MINUTE_MS);
      await write_project_span(project_id, {
        span_id: `med-free-${index}`,
        trace_id: `med-free-${index}`,
        start_time_unix_nano: start,
        end_time_unix_nano: plus(start, 100),
      });
    }
    const stale = ago(40 * 24 * 60 * MINUTE_MS);
    await write_project_span(project_id, {
      span_id: 'med-stale',
      trace_id: 'med-stale',
      start_time_unix_nano: stale,
      end_time_unix_nano: plus(stale, 100),
      cost: 9,
    });

    const res = await api.projects[project_id]!.requests['med-billed-1']!.get({
      $query: range(MONTH_MINUTES),
      $headers: bearer(token),
    });

    expect(res.error).toBeNull();
    expect(res.data?.median_cost).toBe('0.0020000000');
    expect(res.data?.cost_vs_median).toBe(1);
    expect(res.data?.harness_cost_vs_median).toBeNull();
    expect(res.data?.token_count_vs_median).toBeNull();

    const wider = await api.projects[project_id]!.requests['med-billed-1']!.get({
      $query: range(41 * 24 * 60),
      $headers: bearer(token),
    });
    expect(wider.error).toBeNull();
    expect(wider.data?.median_cost).toBe('0.0025000000');
  });

  test('a project that billed nothing in the range reports no median', async () => {
    const token = await authenticate('req-trace-nomedian@canyonos.test');
    const project_id = await create_project(token);
    const start = ago(MINUTE_MS);
    await write_project_span(project_id, {
      span_id: 'nomed-1',
      trace_id: 'nomed',
      start_time_unix_nano: start,
      end_time_unix_nano: plus(start, 100),
    });

    const res = await api.projects[project_id]!.requests['nomed']!.get({
      $query: range(MONTH_MINUTES),
      $headers: bearer(token),
    });

    expect(res.error).toBeNull();
    expect(res.data?.median_cost).toBeNull();
    expect(res.data?.cost_vs_median).toBeNull();
    expect(res.data?.total_cost).toBe('0.0000000000');
  });

  test('a trace never includes another project sharing its trace id', async () => {
    const owner = await authenticate('req-trace-shared@canyonos.test');
    const mine = await create_project(owner);
    const theirs = await create_project(owner);
    const start = ago(MINUTE_MS);

    await write_project_span(mine, {
      span_id: 'tshare-mine-1',
      trace_id: 'tshare',
      name: 'mine',
      start_time_unix_nano: start,
      end_time_unix_nano: plus(start, 100),
      cost: 0.000011,
    });
    await write_project_span(theirs, {
      span_id: 'tshare-theirs-1',
      trace_id: 'tshare',
      name: 'theirs',
      start_time_unix_nano: start,
      end_time_unix_nano: plus(start, 900),
      cost: 0.000099,
    });

    const res = await api.projects[mine]!.requests['tshare']!.get({
      $query: range(MONTH_MINUTES),
      $headers: bearer(owner),
    });

    expect(res.error).toBeNull();
    expect(res.data?.blocks.map((block) => block.future_id)).toEqual(['tshare-mine-1']);
    expect(res.data?.total_cost).toBe('0.0000110000');
    expect(res.data?.duration_ms).toBe(100);
  });

  test('a trace made only of spans without the project attribute is not found', async () => {
    const token = await authenticate('req-trace-orphan@canyonos.test');
    const project_id = await create_project(token);
    await write_unattributed_span({
      span_id: 'lonely-1',
      trace_id: 'lonely',
      start_time_unix_nano: ago(MINUTE_MS),
      end_time_unix_nano: plus(ago(MINUTE_MS), 100),
    });

    const res = await api.projects[project_id]!.requests['lonely']!.get({
      $query: range(MONTH_MINUTES),
      $headers: bearer(token),
    });

    expect(res.error?.status as number).toBe(404);
    expect((res.error?.value as { error?: string })?.error).toBe('requests.not_found');
  });

  test('a malformed numeric attribute is ignored instead of failing the request', async () => {
    const token = await authenticate('req-trace-malformed@canyonos.test');
    const project_id = await create_project(token);
    const start = ago(MINUTE_MS);
    await write_project_span(project_id, {
      span_id: 'bad-1',
      trace_id: 'bad',
      start_time_unix_nano: start,
      end_time_unix_nano: plus(start, 100),
      model: 'gpt-4',
      input_tokens: 'twelve',
      output_tokens: { count: 3 },
      cost: true,
      token_cost: 'free',
      error_count: -2,
    });
    await write_project_span(project_id, {
      span_id: 'bad-2',
      trace_id: 'bad',
      start_time_unix_nano: plus(start, 200),
      end_time_unix_nano: plus(start, 300),
      input_tokens: 1.5,
      error_count: 0.5,
      server_cost: 0.000004,
      cost: 0.000004,
    });

    const listed = await list(token, project_id);
    expect(listed.items[0]).toMatchObject({
      session_id: 'bad',
      block_count: 2,
      token_count: 0,
      error_count: 0,
      llm_cost: '0.0000000000',
      harness_cost: '0.0000040000',
      total_cost: '0.0000040000',
    });

    const res = await api.projects[project_id]!.requests['bad']!.get({
      $query: range(MONTH_MINUTES),
      $headers: bearer(token),
    });
    expect(res.error).toBeNull();
    expect(res.data?.blocks[0]).toMatchObject({
      kind: 'model',
      model: 'gpt-4',
      input_token_count: 0,
      output_token_count: 0,
      errors: 0,
      total_cost: '0.0000000000',
    });
    expect(res.data?.blocks[1]).toMatchObject({
      input_token_count: 0,
      errors: 0,
      total_cost: '0.0000040000',
    });
  });
});
