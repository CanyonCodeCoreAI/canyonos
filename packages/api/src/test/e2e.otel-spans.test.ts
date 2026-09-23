import { describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';

import { db } from '@api/db/client';
import { otelSpans } from '@api/db/schema';
import { PROJECT_ID_ATTRIBUTE } from '@api/modules/metrics/metrics.contract';

import { setupE2ETests } from './e2e.setup';
import { write_project_span, write_unattributed_span } from './telemetry-test.utils';

setupE2ETests();

const SHAPE_PROJECT = '11111111-1111-4111-8111-111111111111';
const ISOLATION_PROJECT_A = '22222222-2222-4222-8222-222222222222';
const ISOLATION_PROJECT_B = '33333333-3333-4333-8333-333333333333';
const ORPHAN_PROJECT = '44444444-4444-4444-8444-444444444444';
const NANOS_PROJECT = '55555555-5555-4555-8555-555555555555';
const PLAN_PROJECT = '66666666-6666-4666-8666-666666666666';

function project_span_ids(project_id: string): Promise<{ span_id: string }[]> {
  return db
    .select({ span_id: otelSpans.span_id })
    .from(otelSpans)
    .where(sql`${otelSpans.attributes} ->> ${PROJECT_ID_ATTRIBUTE} = ${project_id}`)
    .orderBy(otelSpans.span_id);
}

function attributed_span_ids(): Promise<{ span_id: string }[]> {
  return db
    .select({ span_id: otelSpans.span_id })
    .from(otelSpans)
    .where(sql`${otelSpans.attributes} ->> ${PROJECT_ID_ATTRIBUTE} is not null`)
    .orderBy(otelSpans.span_id);
}

describe('otel span schema', () => {
  test('reads a span back through the real schema', async () => {
    await write_project_span(SHAPE_PROJECT, { span_id: 'span-shape', name: 'agent.run' });

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
      attributes: { [PROJECT_ID_ATTRIBUTE]: SHAPE_PROJECT },
      events: [],
      input: null,
      output: null,
    });
  });

  test('a project reads only its own spans', async () => {
    await write_project_span(ISOLATION_PROJECT_A, { span_id: 'span-a1' });
    await write_project_span(ISOLATION_PROJECT_A, { span_id: 'span-a2' });
    await write_project_span(ISOLATION_PROJECT_B, { span_id: 'span-b1' });

    expect(await project_span_ids(ISOLATION_PROJECT_A)).toEqual([
      { span_id: 'span-a1' },
      { span_id: 'span-a2' },
    ]);
    expect(await project_span_ids(ISOLATION_PROJECT_B)).toEqual([{ span_id: 'span-b1' }]);
  });

  test('a span without the project attribute belongs to no project', async () => {
    await write_unattributed_span({ span_id: 'span-orphan' });
    await write_project_span(ORPHAN_PROJECT, { span_id: 'span-owned' });

    const [stored] = await db
      .select({ attributes: otelSpans.attributes })
      .from(otelSpans)
      .where(sql`${otelSpans.span_id} = 'span-orphan'`);
    expect(stored?.attributes).toEqual({});

    expect(await project_span_ids(ORPHAN_PROJECT)).toEqual([{ span_id: 'span-owned' }]);
    expect(await attributed_span_ids()).not.toContainEqual({ span_id: 'span-orphan' });
  });

  test('a project window query can use the composite project/time index', async () => {
    const floor = 1_788_000_000_000_000_000n;
    await write_project_span(PLAN_PROJECT, { span_id: 'span-plan' });

    const plan = await db.transaction(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      const rows = await tx.execute(sql`
        explain select ${otelSpans.span_id}
        from ${otelSpans}
        where ${otelSpans.attributes} ->> ${PROJECT_ID_ATTRIBUTE} = ${PLAN_PROJECT}
          and ${otelSpans.start_time_unix_nano} >= ${floor}
        order by ${otelSpans.start_time_unix_nano}`);
      return rows.map((row) => String(row['QUERY PLAN'])).join('\n');
    });

    expect(plan).toContain('idx_otel_spans_project_start');

    const [setting] = await db.execute(sql`select current_setting('enable_seqscan') as seqscan`);
    expect(setting?.seqscan).toBe('on');
  });

  test('nanosecond timestamps survive the round trip without precision loss', async () => {
    const start = 1_788_000_000_123_456_789n;
    const end = 1_788_000_000_987_654_321n;
    await write_project_span(NANOS_PROJECT, {
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
