// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';

import { db } from '@api/db/client';
import {
  WORKFLOW_GROUP_ID_ATTRIBUTE,
  WORKFLOW_ID_ATTRIBUTE,
} from '@api/modules/telemetry/telemetry.contract';
import { otelSpans } from '@api/modules/telemetry/telemetry.schema';

import { setupE2ETests } from './e2e.setup';
import {
  attribute,
  decode_trace_response,
  encode_trace_export,
  post_otlp,
  write_unattributed_span,
  write_workflow_span,
} from './telemetry-test.utils';
import type { OtlpExportFixture } from './telemetry-test.utils';

setupE2ETests();

const SHAPE_WORKFLOW = '11111111-1111-4111-8111-111111111111';
const ISOLATION_WORKFLOW_A = '22222222-2222-4222-8222-222222222222';
const ISOLATION_WORKFLOW_B = '33333333-3333-4333-8333-333333333333';
const ORPHAN_WORKFLOW = '44444444-4444-4444-8444-444444444444';
const NANOS_WORKFLOW = '55555555-5555-4555-8555-555555555555';
const PLAN_WORKFLOW = '66666666-6666-4666-8666-666666666666';

function workflow_span_ids(workflow_id: string): Promise<{ span_id: string }[]> {
  return db
    .select({ span_id: otelSpans.span_id })
    .from(otelSpans)
    .where(sql`${otelSpans.attributes} ->> ${WORKFLOW_ID_ATTRIBUTE} = ${workflow_id}`)
    .orderBy(otelSpans.span_id);
}

function attributed_span_ids(): Promise<{ span_id: string }[]> {
  return db
    .select({ span_id: otelSpans.span_id })
    .from(otelSpans)
    .where(sql`${otelSpans.attributes} ->> ${WORKFLOW_ID_ATTRIBUTE} is not null`)
    .orderBy(otelSpans.span_id);
}

describe('otel span schema', () => {
  test('reads a span back through the real schema', async () => {
    await write_workflow_span(SHAPE_WORKFLOW, { span_id: 'span-shape', name: 'agent.run' });

    const [span] = await db
      .select()
      .from(otelSpans)
      .where(sql`${otelSpans.span_id} = 'span-shape'`);

    expect(span).toMatchObject({
      span_id: 'span-shape',
      trace_id: 'trace-span-shape',
      parent_span_id: null,
      name: 'agent.run',
      kind: 'SPAN_KIND_UNSPECIFIED',
      status_code: 'STATUS_CODE_UNSET',
      status_message: null,
      attributes: { [WORKFLOW_ID_ATTRIBUTE]: SHAPE_WORKFLOW },
      events: [],
      input: null,
      output: null,
    });
  });

  test('a workflow reads only its own spans', async () => {
    await write_workflow_span(ISOLATION_WORKFLOW_A, { span_id: 'span-a1' });
    await write_workflow_span(ISOLATION_WORKFLOW_A, { span_id: 'span-a2' });
    await write_workflow_span(ISOLATION_WORKFLOW_B, { span_id: 'span-b1' });

    expect(await workflow_span_ids(ISOLATION_WORKFLOW_A)).toEqual([
      { span_id: 'span-a1' },
      { span_id: 'span-a2' },
    ]);
    expect(await workflow_span_ids(ISOLATION_WORKFLOW_B)).toEqual([{ span_id: 'span-b1' }]);
  });

  test('a span without the workflow attribute belongs to no workflow', async () => {
    await write_unattributed_span({ span_id: 'span-orphan' });
    await write_workflow_span(ORPHAN_WORKFLOW, { span_id: 'span-owned' });

    const [stored] = await db
      .select({ attributes: otelSpans.attributes })
      .from(otelSpans)
      .where(sql`${otelSpans.span_id} = 'span-orphan'`);
    expect(stored?.attributes).toEqual({});

    expect(await workflow_span_ids(ORPHAN_WORKFLOW)).toEqual([{ span_id: 'span-owned' }]);
    expect(await attributed_span_ids()).not.toContainEqual({ span_id: 'span-orphan' });
  });

  test('a workflow window query can use the composite workflow/time index', async () => {
    const floor = 1_788_000_000_000_000_000n;
    await write_workflow_span(PLAN_WORKFLOW, { span_id: 'span-plan' });

    const plan = await db.transaction(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      const rows = await tx.execute(sql`
        explain select ${otelSpans.span_id}
        from ${otelSpans}
        where ${otelSpans.attributes} ->> ${WORKFLOW_ID_ATTRIBUTE} = ${PLAN_WORKFLOW}
          and ${otelSpans.start_time_unix_nano} >= ${floor}
        order by ${otelSpans.start_time_unix_nano}`);
      return rows.map((row) => String(row['QUERY PLAN'])).join('\n');
    });

    expect(plan).toContain('idx_otel_spans_workflow_start');

    const [setting] = await db.execute(sql`select current_setting('enable_seqscan') as seqscan`);
    expect(setting?.seqscan).toBe('on');
  });

  test('nanosecond timestamps survive the round trip without precision loss', async () => {
    const start = 1_788_000_000_123_456_789n;
    const end = 1_788_000_000_987_654_321n;
    await write_workflow_span(NANOS_WORKFLOW, {
      span_id: 'span-nanos',
      start_time_unix_nano: start,
      end_time_unix_nano: end,
    });

    const [span] = await db
      .select({
        start_time_unix_nano: otelSpans.start_time_unix_nano,
        end_time_unix_nano: otelSpans.end_time_unix_nano,
      })
      .from(otelSpans)
      .where(sql`${otelSpans.span_id} = 'span-nanos'`);

    expect(span?.start_time_unix_nano).toBe(start);
    expect(span?.end_time_unix_nano).toBe(end);
    expect(BigInt(Number(start))).not.toBe(start);
  });
});

describe('otlp trace ingest', () => {
  test("a span with another workflow group's id, or none, is rejected and not stored", async () => {
    const workflow_group_id = crypto.randomUUID();
    const trace_id = crypto.getRandomValues(new Uint8Array(16));
    const span = (name: string, attributes: readonly OtlpExportFixture[]) => ({
      traceId: trace_id,
      spanId: crypto.getRandomValues(new Uint8Array(8)),
      name,
      startTimeUnixNano: '1788000000000000000',
      endTimeUnixNano: '1788000000001000000',
      attributes,
    });

    const response = await post_otlp(
      workflow_group_id,
      'traces',
      encode_trace_export({
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  span('other-group', [
                    attribute(WORKFLOW_GROUP_ID_ATTRIBUTE, crypto.randomUUID()),
                  ]),
                  span('no-group', []),
                  span('kept', [attribute(WORKFLOW_GROUP_ID_ATTRIBUTE, workflow_group_id)]),
                ],
              },
            ],
          },
        ],
      })
    );

    expect(response.status).toBe(200);
    expect(decode_trace_response(await response.arrayBuffer())).toEqual({
      partialSuccess: {
        rejectedSpans: 2,
        errorMessage:
          "2 span(s) rejected: a span needs a span id, a trace id, a non-zero end time and this workflow group's id.",
      },
    });
    const stored = await db
      .select({ name: otelSpans.name })
      .from(otelSpans)
      .where(sql`${otelSpans.trace_id} = ${Buffer.from(trace_id).toString('hex')}`);
    expect(stored).toEqual([{ name: 'kept' }]);
  });
});
