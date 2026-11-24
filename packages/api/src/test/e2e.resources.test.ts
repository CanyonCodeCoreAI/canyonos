// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test';

import { db } from '@api/db/client';
import { GEN_AI } from '@api/modules/metrics/metrics.contract';
import { WORKFLOW_ID_ATTRIBUTE } from '@api/modules/telemetry/telemetry.contract';
import { otelSpans } from '@api/modules/telemetry/telemetry.schema';

import { api, setupE2ETests } from './e2e.setup';
import { write_unattributed_span, write_workflow_span } from './telemetry-test.utils';
import { bearer, create_test_workflow, TEST_API_KEY } from './workflow-test.utils';

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

/** A workflow created `ms_ago`, in a workflow group of its own that takes TEST_API_KEY, or
 * `api_key`. */
async function insert_workflow(
  name: string,
  ms_ago: number,
  api_key: string = TEST_API_KEY
): Promise<string> {
  const { workflow_id } = await create_test_workflow({ name, api_key, created_at: at(ms_ago) });
  return workflow_id;
}

async function insert_span(workflow_id: string, span: SpanSeed): Promise<void> {
  const start = nanos_ago(span.ms_ago);
  await write_workflow_span(workflow_id, {
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

// The range [now - from_ms_ago, now - to_ms_ago), as the dashboard would send it.
const range = (from_ms_ago: number, to_ms_ago = 0) => ({
  from: new Date(Date.now() - from_ms_ago).toISOString(),
  to: new Date(Date.now() - to_ms_ago).toISOString(),
});

const overview = (token: string, query: { from: string; to: string }) =>
  api.v1.resources.overview.get({ $headers: bearer(token), $query: query });

const tokens_usage = (workflow: {
  resource_usage: { resource_id: string; usage: number }[];
}): number => workflow.resource_usage.find((usage) => usage.resource_id === 'tokens')!.usage;

// The fleet spans the whole install, so every assertion below picks the rows the test seeded.
type FleetWorkflow = NonNullable<Awaited<ReturnType<typeof overview>>['data']>['workflows'][number];

const fleet_row = (data: { workflows: FleetWorkflow[] }, workflow_id: string): FleetWorkflow =>
  data.workflows.find((workflow) => workflow.id === workflow_id)!;

const fleet_rows = (data: { workflows: FleetWorkflow[] }, ids: string[]): FleetWorkflow[] =>
  data.workflows.filter((workflow) => ids.includes(workflow.id));

describe('GET /v1/resources/overview', () => {
  test('a request without a key shows no workflow of a workflow group that has one', async () => {
    const keyed = await insert_workflow('Keyed', DAY_MS);

    const res = await api.v1.resources.overview.get({ $query: range(30 * DAY_MS) });
    expect(res.error).toBeNull();
    expect(res.data!.workflows.map(({ id }) => id)).not.toContain(keyed);
  });

  test("a workflow group's key shows its own workflows and not another's; a key that opens none is 401", async () => {
    const other_key = `another-group-${crypto.randomUUID()}`;
    const mine = await insert_workflow('Shown', DAY_MS);
    const theirs = await insert_workflow('Hidden', DAY_MS, other_key);

    const shown = (await overview(TEST_API_KEY, range(30 * DAY_MS))).data!.workflows;
    expect(shown.map(({ id }) => id)).toContain(mine);
    expect(shown.map(({ id }) => id)).not.toContain(theirs);
    const other = (await overview(other_key, range(30 * DAY_MS))).data!.workflows;
    expect(other.map(({ id }) => id)).toEqual(expect.not.arrayContaining([mine]));
    expect(other.map(({ id }) => id)).toContain(theirs);
    expect((await overview('opens-nothing', range(30 * DAY_MS))).error?.status as number).toBe(401);
  });

  test('derives per-workflow cost, requests and tokens from workflow spans', async () => {
    const token = TEST_API_KEY;

    const alpha = await insert_workflow('Alpha', 3 * DAY_MS);
    const bravo = await insert_workflow('Bravo', 2 * DAY_MS);
    const charlie = await insert_workflow('Charlie', 1 * DAY_MS);

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

    const res = await overview(token, range(30 * DAY_MS));
    expect(res.error).toBeNull();
    const data = res.data!;

    const mine = fleet_rows(data, [alpha, bravo, charlie]);
    expect(mine.map((workflow) => workflow.id)).toEqual([alpha, bravo, charlie]);
    expect(mine.map((workflow) => workflow.name)).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(mine.map((workflow) => workflow.requests)).toEqual([2, 1, 0]);
    expect(mine.map((workflow) => workflow.cost)).toEqual([1, 1, 0]);
    expect(mine.map((workflow) => tokens_usage(workflow))).toEqual([1.2, 0.3, 0]);
    expect(mine.map((workflow) => workflow.avg_latency_ms)).toEqual([2000, 2000, 0]);
    expect(mine.every((workflow) => workflow.error_rate_pct === 0)).toBe(true);

    const untracked = data.resources.filter((resource) => resource.id !== 'tokens');
    expect(untracked.map((resource) => resource.id)).toEqual(['gpu', 'cpu', 'mem', 'storage']);
    expect(untracked.every((resource) => resource.available === false)).toBe(true);
    expect(untracked.every((resource) => resource.pool === 0)).toBe(true);
    for (const workflow of mine) {
      const untracked_usage = workflow.resource_usage.filter(
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
    const token = TEST_API_KEY;
    const workflow = await insert_workflow('OneTrace', DAY_MS);

    await insert_span(workflow, {
      span_id: 'one-trace-a',
      trace_id: 'one-trace',
      ms_ago: 2 * HOUR_MS,
      duration_ms: 1000,
      input_tokens: 100,
      cost: 0.1,
    });
    await insert_span(workflow, {
      span_id: 'one-trace-b',
      trace_id: 'one-trace',
      ms_ago: 2 * HOUR_MS,
      duration_ms: 3000,
      input_tokens: 300,
      cost: 0.3,
    });

    const res = await overview(token, range(30 * DAY_MS));
    expect(res.error).toBeNull();
    const workflow_row = fleet_row(res.data!, workflow);

    expect(workflow_row.requests).toBe(1);
    expect(workflow_row.cost).toBe(0.4);
    // Latency stays a per-span average across both spans, not a per-trace wall clock.
    expect(workflow_row.avg_latency_ms).toBe(2000);
  });

  test('a span with no canyonos.workflow.id is invisible', async () => {
    const token = TEST_API_KEY;
    const workflow = await insert_workflow('Owned', DAY_MS);

    await insert_span(workflow, {
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

    const res = await overview(token, range(30 * DAY_MS));
    expect(res.error).toBeNull();
    const workflow_row = fleet_row(res.data!, workflow);

    expect(workflow_row.requests).toBe(1);
    expect(workflow_row.cost).toBe(0.1);
    expect(tokens_usage(workflow_row)).toBe(0);
    expect(workflow_row.avg_latency_ms).toBe(1000);
  });

  test('one trace id in two workflows stays isolated', async () => {
    const token = TEST_API_KEY;
    const first = await insert_workflow('First', 2 * DAY_MS);
    const second = await insert_workflow('Second', DAY_MS);

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

    const res = await overview(token, range(30 * DAY_MS));
    expect(res.error).toBeNull();
    const first_row = fleet_row(res.data!, first);
    const second_row = fleet_row(res.data!, second);

    expect(first_row).toMatchObject({ requests: 1, cost: 0.1, avg_latency_ms: 1000 });
    expect(second_row).toMatchObject({ requests: 1, cost: 0.3, avg_latency_ms: 3000 });
    expect(tokens_usage(first_row)).toBe(0.1);
    expect(tokens_usage(second_row)).toBe(0.3);
  });

  test('each workflow appears with its own totals', async () => {
    const token = TEST_API_KEY;
    const my_workflow = await insert_workflow('Mine', DAY_MS);
    const their_workflow = await insert_workflow('Theirs', DAY_MS);

    await insert_span(my_workflow, {
      span_id: 'mine-s',
      trace_id: 'mine-trace',
      ms_ago: 2 * HOUR_MS,
      duration_ms: 1000,
      input_tokens: 100,
      cost: 0.1,
    });
    await insert_span(their_workflow, {
      span_id: 'theirs-s',
      trace_id: 'theirs-trace',
      ms_ago: 2 * HOUR_MS,
      duration_ms: 1000,
      input_tokens: 500,
      cost: 5,
    });

    const res = await overview(token, range(30 * DAY_MS));
    expect(res.error).toBeNull();
    expect(fleet_row(res.data!, my_workflow).cost).toBe(0.1);
    expect(fleet_row(res.data!, their_workflow)).toMatchObject({ name: 'Theirs', cost: 5 });
  });

  test('a narrow window excludes older spans', async () => {
    const token = TEST_API_KEY;
    const workflow = await insert_workflow('Windowed', 40 * DAY_MS);

    await insert_span(workflow, {
      span_id: 'win-recent-s',
      trace_id: 'win-recent',
      ms_ago: 2 * HOUR_MS,
      duration_ms: 1000,
      input_tokens: 100_000,
      cost: 0.1,
    });
    await insert_span(workflow, {
      span_id: 'win-older-s',
      trace_id: 'win-older',
      ms_ago: 3 * DAY_MS,
      duration_ms: 1000,
      input_tokens: 200_000,
      cost: 0.2,
    });

    const day = await overview(token, range(DAY_MS));
    expect(day.error).toBeNull();
    expect(fleet_row(day.data!, workflow).requests).toBe(1);
    expect(tokens_usage(fleet_row(day.data!, workflow))).toBe(0.1);

    const week = await overview(token, range(7 * DAY_MS));
    expect(week.error).toBeNull();
    expect(fleet_row(week.data!, workflow).requests).toBe(2);
    expect(tokens_usage(fleet_row(week.data!, workflow))).toBe(0.3);

    const before_today = await overview(token, range(7 * DAY_MS, DAY_MS));
    expect(before_today.error).toBeNull();
    expect(fleet_row(before_today.data!, workflow).requests).toBe(1);
    expect(tokens_usage(fleet_row(before_today.data!, workflow))).toBe(0.2);
  });

  test('a range whose from is not before its to is rejected with 422', async () => {
    const token = TEST_API_KEY;
    const { from, to } = range(DAY_MS);

    const res = await overview(token, { from: to, to: from });
    expect(res.error?.status as number).toBe(422);
  });

  test('an ERROR status span drives the error rate', async () => {
    const token = TEST_API_KEY;
    const workflow = await insert_workflow('Erroring', DAY_MS);

    await insert_span(workflow, {
      span_id: 'err-ok-1',
      trace_id: 'err-trace',
      ms_ago: 2 * HOUR_MS,
      duration_ms: 1000,
      input_tokens: 10,
      cost: 0.01,
    });
    await insert_span(workflow, {
      span_id: 'err-ok-2',
      trace_id: 'err-trace',
      ms_ago: 2 * HOUR_MS,
      duration_ms: 1000,
      input_tokens: 10,
      cost: 0.01,
    });
    await insert_span(workflow, {
      span_id: 'err-failed',
      trace_id: 'err-trace',
      ms_ago: 2 * HOUR_MS,
      duration_ms: 1000,
      input_tokens: 10,
      cost: 0.01,
      failed: true,
    });

    const res = await overview(token, range(30 * DAY_MS));
    expect(res.error).toBeNull();
    expect(fleet_row(res.data!, workflow).error_rate_pct).toBeCloseTo(100 / 3, 10);
  });

  test('tokens sum input and output, and latency averages the span durations', async () => {
    const token = TEST_API_KEY;
    const workflow = await insert_workflow('Derived', DAY_MS);

    await insert_span(workflow, {
      span_id: 'derive-both',
      trace_id: 'derive-a',
      ms_ago: 2 * HOUR_MS,
      duration_ms: 400,
      input_tokens: 400_000,
      output_tokens: 100_000,
      cost: 0.5,
    });
    await insert_span(workflow, {
      span_id: 'derive-none',
      trace_id: 'derive-b',
      ms_ago: 2 * HOUR_MS,
      duration_ms: 800,
      cost: 0.5,
    });

    const res = await overview(token, range(30 * DAY_MS));
    expect(res.error).toBeNull();
    const workflow_row = fleet_row(res.data!, workflow);

    expect(tokens_usage(workflow_row)).toBe(0.5);
    expect(workflow_row.avg_latency_ms).toBe(600);
    expect(workflow_row.cost).toBe(1);
  });

  test('attributes of the wrong type and invalid counts are absent, not a failure', async () => {
    const token = TEST_API_KEY;
    const workflow = await insert_workflow('Malformed', DAY_MS);

    const start = nanos_ago(2 * HOUR_MS);
    await db.insert(otelSpans).values({
      span_id: 'malformed-s',
      trace_id: 'malformed-trace',
      name: 'malformed',
      start_time_unix_nano: start,
      end_time_unix_nano: start + 500n * NANOS_PER_MS,
      attributes: {
        [WORKFLOW_ID_ATTRIBUTE]: workflow,
        [GEN_AI.USAGE_COST]: 'free',
        [GEN_AI.INPUT_TOKENS]: { count: 5 },
        [GEN_AI.OUTPUT_TOKENS]: ['7'],
      },
    });
    await insert_span(workflow, {
      span_id: 'malformed-counts',
      trace_id: 'malformed-counts-trace',
      ms_ago: 2 * HOUR_MS,
      duration_ms: 500,
      input_tokens: -5,
      output_tokens: 1.5,
      cost: 0.25,
    });

    const res = await overview(token, range(30 * DAY_MS));
    expect(res.error).toBeNull();
    const workflow_row = fleet_row(res.data!, workflow);

    expect(workflow_row.requests).toBe(2);
    expect(tokens_usage(workflow_row)).toBe(0);
    expect(workflow_row.cost).toBe(0.25);
    expect(workflow_row.avg_latency_ms).toBe(500);
    expect(workflow_row.error_rate_pct).toBe(0);
  });
});
