import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  clear_workflow_generation_mock,
  set_workflow_generation_mock,
} from '../modules/workflows/workflows.generation.testkit';
import { workflows_queue } from '../modules/workflows/workflows.queue';
import { api, setupE2ETests } from './e2e.setup';
import { authenticate, bearer } from './project-test.utils';
import { write_project_span, write_unattributed_span } from './telemetry-test.utils';
import type {
  RequestListItem,
  RequestSort,
  SortDirection,
} from '../modules/requests/requests.types';

setupE2ETests();

// Off-path generation would otherwise run the static analyzer on every project create.
beforeEach(() => {
  set_workflow_generation_mock(async () => ({ status: 'failed', error_message: 'requests test' }));
});

afterEach(async () => {
  await workflows_queue.idle();
  clear_workflow_generation_mock();
});

const VALID_REQUEST_ID = 'req_00000001';

async function create_project(token: string): Promise<string> {
  const project = await api.projects.post(
    { name: 'Requests Project', files: [{ path: 'workflow.py', content: 'def run(): pass\n' }] },
    { headers: bearer(token) }
  );
  expect(project.error).toBeNull();
  return project.data!.project.id;
}

const NANOS_PER_MS = 1_000_000n;
const MINUTE_MS = 60 * 1000;

// One frozen reference: deriving each span from Date.now() at insert time would skew the fixtures
// by the milliseconds between inserts.
const BASE_NANOS = BigInt(Date.now()) * NANOS_PER_MS;

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
    $query: { limit: 20, offset: 0, ...query },
    $headers: bearer(token),
  });
  expect(res.error).toBeNull();
  return res.data!;
}

const ids = (items: readonly RequestListItem[]): string[] => items.map((item) => item.session_id);

describe('request trace endpoint', () => {
  test('the owner gets 404 when an owned project has no matching request', async () => {
    const token = await authenticate('req-owner@cc-forge.test');
    const project_id = await create_project(token);

    const res = await api.projects[project_id]!.requests[VALID_REQUEST_ID]!.get({
      $headers: bearer(token),
    });

    expect(res.error?.status as number).toBe(404);
    expect((res.error?.value as { error?: string })?.error).toBe('requests.not_found');
  });

  test('an unknown project id is 404 projects.not_found, not requests.not_found', async () => {
    const token = await authenticate('req-owner2@cc-forge.test');
    const unknown = '00000000-0000-4000-8000-000000000000';

    const res = await api.projects[unknown]!.requests[VALID_REQUEST_ID]!.get({
      $headers: bearer(token),
    });

    expect(res.error?.status as number).toBe(404);
    expect((res.error?.value as { error?: string })?.error).toBe('projects.not_found');
  });

  test('a request without a token is rejected with 401', async () => {
    const owner = await authenticate('req-owner3@cc-forge.test');
    const project_id = await create_project(owner);

    const res = await api.projects[project_id]!.requests[VALID_REQUEST_ID]!.get();
    expect(res.error?.status as number).toBe(401);
  });

  test('an oversized request id is rejected by validation (422)', async () => {
    const token = await authenticate('req-badreq@cc-forge.test');
    const project_id = await create_project(token);

    const res = await api.projects[project_id]!.requests['x'.repeat(256)]!.get({
      $headers: bearer(token),
    });
    expect(res.error?.status as number).toBe(422);
  });

  test('a non-uuid project id is rejected by validation (422)', async () => {
    const token = await authenticate('req-baduuid@cc-forge.test');
    const res = await api.projects['not-a-uuid']!.requests[VALID_REQUEST_ID]!.get({
      $headers: bearer(token),
    });
    expect(res.error?.status as number).toBe(422);
  });
});

describe('GET /projects/:project_id/requests (listing with rollups)', () => {
  test('lists requests newest-first with status, duration, token, and cost rollups', async () => {
    const token = await authenticate('req-list@cc-forge.test');
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
      llm_cost: '0.000300',
      harness_cost: '0.000030',
      total_cost: '0.000330',
    });

    const failed = page.items[2]!;
    expect(failed).toMatchObject({
      status: 'failed',
      block_count: 1,
      failed_block_count: 1,
      duration_ms: 500,
      token_count: 0,
      total_cost: '0.000030',
    });
  });

  test('every request reports a finish time and a duration', async () => {
    const token = await authenticate('req-finished@cc-forge.test');
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
    const token = await authenticate('req-page@cc-forge.test');
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
    const token = await authenticate('req-status@cc-forge.test');
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
    const token = await authenticate('req-running@cc-forge.test');
    const project_id = await create_project(token);
    await seed(project_id, listing_spans('run'));

    const running = await list(token, project_id, { status: 'running' });

    expect(running.total).toBe(0);
    expect(running.items).toEqual([]);
  });

  test('an empty project lists zero requests', async () => {
    const token = await authenticate('req-empty@cc-forge.test');
    const project_id = await create_project(token);

    const page = await list(token, project_id);

    expect(page).toEqual({ total: 0, items: [] });
  });

  test('a span without the project attribute is invisible to every project', async () => {
    const token = await authenticate('req-orphan@cc-forge.test');
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
    const owner = await authenticate('req-shared-trace@cc-forge.test');
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
      total_cost: '0.000011',
    });
  });

  test('an unselected window includes only requests with in-window spans', async () => {
    const token = await authenticate('req-window@cc-forge.test');
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

    const all = await list(token, project_id);
    const day = await list(token, project_id, { time_window: '1d' });

    expect(all.total).toBe(5);
    expect(ids(all.items)).toContain('win-ancient');
    expect(day.total).toBe(4);
    expect(ids(day.items)).not.toContain('win-ancient');
  });

  test("another company reads the project's requests", async () => {
    const owner = await authenticate('req-list-owner@cc-forge.test');
    const project_id = await create_project(owner);
    await seed(project_id, listing_spans('guard'));

    const other_company = await authenticate('req-list-intruder@cc-forge.test');
    const res = await api.projects[project_id]!.requests.get({
      $query: { limit: 20, offset: 0 },
      $headers: bearer(other_company),
    });

    expect(res.error).toBeNull();
    expect(res.data!.total).toBeGreaterThan(0);
  });

  test('a listing without a token is rejected with 401', async () => {
    const owner = await authenticate('req-list-anon@cc-forge.test');
    const project_id = await create_project(owner);

    const res = await api.projects[project_id]!.requests.get({ $query: { limit: 20, offset: 0 } });
    expect(res.error?.status as number).toBe(401);
  });

  test('an out-of-range limit is rejected by validation (422)', async () => {
    const token = await authenticate('req-limit@cc-forge.test');
    const project_id = await create_project(token);

    const res = await api.projects[project_id]!.requests.get({
      $query: { limit: 500, offset: 0 },
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
    token = await authenticate(`req-order-${Bun.randomUUIDv7()}@cc-forge.test`);
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
      $query: { limit: 20, offset: 0, sort: 'nonsense' as RequestSort },
      $headers: bearer(token),
    });
    expect(res.error?.status as number).toBe(422);
  });

  test('an unknown order direction is rejected by validation (422)', async () => {
    const res = await api.projects[project_id]!.requests.get({
      $query: { limit: 20, offset: 0, sort: 'total_cost', order: 'sideways' as SortDirection },
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
    token = await authenticate(`req-range-${Bun.randomUUIDv7()}@cc-forge.test`);
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
    ids((await list(token, project_id, { metric, min, max, time_window: '30d' })).items);

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
      time_window: '30d',
    });

    expect(page.total).toBe(2);
    expect(page.items).toHaveLength(2);
  });

  test('an order composes with a range instead of replacing it', async () => {
    const page = await list(token, project_id, {
      metric: 'cost_per_request',
      min: 0.0015,
      max: 0.0035,
      time_window: '30d',
      sort: 'total_cost',
      order: 'desc',
    });

    expect(ids(page.items)).toEqual([`${prefix}-3`, `${prefix}-2`]);
  });

  test('a half-specified selection is rejected by validation (422)', async () => {
    const res = await api.projects[project_id]!.requests.get({
      $query: { limit: 20, offset: 0, metric: 'cost_per_request', min: 1 },
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

describe('GET /projects/:project_id/requests (creation-date filtering)', () => {
  let token: string;
  let project_id: string;
  let prefix: string;
  let day_start: string;
  let day_end: string;

  beforeEach(async () => {
    token = await authenticate(`req-day-${Bun.randomUUIDv7()}@cc-forge.test`);
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
      created_from: day_start,
      created_to: day_end,
    });

    expect(ids(page.items).sort()).toEqual([`${prefix}-edge`, `${prefix}-inside`].sort());
    expect(page.total).toBe(2);
  });

  test('created_from alone lists every request since that instant', async () => {
    const page = await list(token, project_id, { created_from: day_start });
    expect(ids(page.items)).not.toContain(`${prefix}-before`);
    expect(page.total).toBe(2);
  });

  test('created_to alone lists every request before that instant', async () => {
    const page = await list(token, project_id, { created_to: day_start });
    expect(ids(page.items)).toEqual([`${prefix}-before`]);
  });

  test('a day window narrows a status filter instead of replacing it', async () => {
    const page = await list(token, project_id, {
      created_from: day_start,
      created_to: day_end,
      status: 'failed',
    });

    expect(ids(page.items)).toEqual([`${prefix}-inside`]);
  });

  test('a day with no requests lists nothing', async () => {
    const empty_from = new Date(Date.parse(day_start) - 30 * 24 * 60 * MINUTE_MS).toISOString();
    const empty_to = new Date(Date.parse(empty_from) + 24 * 60 * MINUTE_MS).toISOString();

    const page = await list(token, project_id, { created_from: empty_from, created_to: empty_to });

    expect(page).toEqual({ total: 0, items: [] });
  });

  test('a window that ends before it starts is rejected by validation (422)', async () => {
    const res = await api.projects[project_id]!.requests.get({
      $query: { limit: 20, offset: 0, created_from: day_end, created_to: day_start },
      $headers: bearer(token),
    });
    expect(res.error?.status as number).toBe(422);
  });

  test('a bound that is not an instant is rejected by validation (422)', async () => {
    const res = await api.projects[project_id]!.requests.get({
      $query: { limit: 20, offset: 0, created_from: '2026-09-01T00:00:00' },
      $headers: bearer(token),
    });
    expect(res.error?.status as number).toBe(422);
  });
});

describe('GET /projects/:project_id/requests/:request_id', () => {
  test('returns one request trace with ordered blocks and the project median', async () => {
    const token = await authenticate('req-trace@cc-forge.test');
    const project_id = await create_project(token);
    await seed(project_id, listing_spans('tr'));

    const res = await api.projects[project_id]!.requests['tr-done']!.get({
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
      total_cost: '0.000330',
      harness_cost: '0.000030',
    });
    expect(trace.input).toEqual({ prompt: 'done' });
    expect(trace.output).toEqual({ result: 'done' });
    expect(trace.median_cost).not.toBeNull();

    expect(trace.blocks.map((block) => block.future_id)).toEqual(['tr-done-1', 'tr-done-2']);
    expect(trace.blocks[0]).toMatchObject({
      label: 'plan',
      kind: 'model',
      model: 'claude-sonnet',
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
      started_offset_ms: 2000,
      execution_time_ms: 3000,
      errors: 1,
    });
  });

  test('a failed span makes the whole request failed', async () => {
    const token = await authenticate('req-trace-failed@cc-forge.test');
    const project_id = await create_project(token);
    await seed(project_id, listing_spans('trf'));

    const res = await api.projects[project_id]!.requests['trf-failed']!.get({
      $headers: bearer(token),
    });

    expect(res.data?.status).toBe('failed');
    expect(res.data?.blocks[0]?.failed).toBe(true);
  });

  test('a payload that is not JSON is preserved as the text it was', async () => {
    const token = await authenticate('req-trace-text@cc-forge.test');
    const project_id = await create_project(token);
    await seed(project_id, listing_spans('trt'));

    const res = await api.projects[project_id]!.requests['trt-recent']!.get({
      $headers: bearer(token),
    });

    expect(res.data?.input).toEqual({ prompt: 'recent' });
    expect(res.data?.output).toBe('plain recent answer');
  });

  test('the median reads only requests that billed inside the trailing 30 days', async () => {
    const token = await authenticate('req-median@cc-forge.test');
    const project_id = await create_project(token);

    // Billed: 0.001, 0.002, 0.003 -> median 0.002. Counting the two unbilled requests as $0 would
    // drag it to 0.001, and the 40-day-old request would pull it to 0.003.
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
      $headers: bearer(token),
    });

    expect(res.error).toBeNull();
    expect(res.data?.median_cost).toBe('0.002000');
  });

  test('a project that billed nothing in the window reports no median', async () => {
    const token = await authenticate('req-trace-nomedian@cc-forge.test');
    const project_id = await create_project(token);
    const start = ago(MINUTE_MS);
    await write_project_span(project_id, {
      span_id: 'nomed-1',
      trace_id: 'nomed',
      start_time_unix_nano: start,
      end_time_unix_nano: plus(start, 100),
    });

    const res = await api.projects[project_id]!.requests['nomed']!.get({ $headers: bearer(token) });

    expect(res.error).toBeNull();
    expect(res.data?.median_cost).toBeNull();
    expect(res.data?.total_cost).toBe('0.000000');
  });

  test('a trace never includes another project sharing its trace id', async () => {
    const owner = await authenticate('req-trace-shared@cc-forge.test');
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

    const res = await api.projects[mine]!.requests['tshare']!.get({ $headers: bearer(owner) });

    expect(res.error).toBeNull();
    expect(res.data?.blocks.map((block) => block.future_id)).toEqual(['tshare-mine-1']);
    expect(res.data?.total_cost).toBe('0.000011');
    expect(res.data?.duration_ms).toBe(100);
  });

  test('a trace made only of spans without the project attribute is not found', async () => {
    const token = await authenticate('req-trace-orphan@cc-forge.test');
    const project_id = await create_project(token);
    await write_unattributed_span({
      span_id: 'lonely-1',
      trace_id: 'lonely',
      start_time_unix_nano: ago(MINUTE_MS),
      end_time_unix_nano: plus(ago(MINUTE_MS), 100),
    });

    const res = await api.projects[project_id]!.requests['lonely']!.get({
      $headers: bearer(token),
    });

    expect(res.error?.status as number).toBe(404);
    expect((res.error?.value as { error?: string })?.error).toBe('requests.not_found');
  });

  test('a malformed numeric attribute is ignored instead of failing the request', async () => {
    const token = await authenticate('req-trace-malformed@cc-forge.test');
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
      llm_cost: '0.000000',
      harness_cost: '0.000004',
      total_cost: '0.000004',
    });

    const res = await api.projects[project_id]!.requests['bad']!.get({ $headers: bearer(token) });
    expect(res.error).toBeNull();
    expect(res.data?.blocks[0]).toMatchObject({
      kind: 'model',
      model: 'gpt-4',
      input_token_count: 0,
      output_token_count: 0,
      errors: 0,
      total_cost: '0.000000',
    });
    expect(res.data?.blocks[1]).toMatchObject({
      input_token_count: 0,
      errors: 0,
      total_cost: '0.000004',
    });
  });
});
