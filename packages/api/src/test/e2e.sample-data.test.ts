// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';

import { db } from '@api/db/client';
import {
  RESOURCE_WORKFLOW_ATTRIBUTE,
  WORKFLOW_ID_ATTRIBUTE,
} from '@api/modules/telemetry/telemetry.contract';
import {
  otelLogs,
  otelMetricRollups,
  otelMetrics,
  otelSpans,
} from '@api/modules/telemetry/telemetry.schema';
import { SAMPLE_ATTRIBUTE } from '@api/modules/workflows/sample-data';

import { group_workflow, setupE2ETests } from './e2e.setup';
import { write_workflow_span } from './telemetry-test.utils';
import { bearer, create_test_workflow, TEST_API_KEY } from './workflow-test.utils';

setupE2ETests();

const key_headers = bearer(TEST_API_KEY);

const NANOS_PER_DAY = 86_400_000_000_000n;

const WORKFLOWS = ['helloworld', 'portfolio'] as const;

// A Portfolio replay writes ~34k rows: ~2.5s locally, past bun's 5s default on a CI runner.
const REPLAY_TIMEOUT_MS = 60_000;

const add_sample_data = (workflow_id: string, token: string, workflow: string) =>
  group_workflow(workflow_id)['sample-data'].post(
    // Typed as the enum; the refusal test sends what the enum would not allow.
    { workflow } as { workflow: (typeof WORKFLOWS)[number] },
    { headers: key_headers }
  );

const workflow_spans = async (workflow_id: string) => {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(otelSpans)
    .where(sql`${otelSpans.attributes} ->> ${WORKFLOW_ID_ATTRIBUTE} = ${workflow_id}`);
  return row!.n;
};

const workflow_rows = async (
  table: typeof otelLogs | typeof otelMetrics | typeof otelMetricRollups,
  workflow_id: string
) => {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(table)
    .where(sql`${table.resource_attributes} ->> ${RESOURCE_WORKFLOW_ATTRIBUTE} = ${workflow_id}`);
  return row!.n;
};

// Rollups are upserted, so a missed delete keeps the row count and doubles `count` instead.
const rollup_samples = async (workflow_id: string) => {
  const [row] = await db
    .select({ n: sql<number>`coalesce(sum(${otelMetricRollups.count}), 0)::int` })
    .from(otelMetricRollups)
    .where(
      sql`${otelMetricRollups.resource_attributes} ->> ${RESOURCE_WORKFLOW_ATTRIBUTE} = ${workflow_id}`
    );
  return row!.n;
};

describe('sample data refuses', () => {
  test('a workflow the api ships no recording of, and writes nothing', async () => {
    const token = TEST_API_KEY;
    const { workflow_id } = await create_test_workflow({ name: 'Unknown' });

    const refused = await add_sample_data(workflow_id, token, 'not-a-workflow');

    expect(refused.status).toBe(422);
    expect(await workflow_spans(workflow_id)).toBe(0);
    expect(await workflow_rows(otelMetrics, workflow_id)).toBe(0);
  });

  test('a workflow under a workflow group it is not in, 404 workflows.not_found, and writes nothing', async () => {
    const { workflow_id } = await create_test_workflow({ name: 'Own Group' });
    const { workflow_id: other_group_id } = await create_test_workflow({ name: 'Other Group' });

    const refused = await group_workflow(workflow_id, other_group_id)['sample-data'].post(
      { workflow: 'helloworld' },
      { headers: key_headers }
    );

    expect(refused.error?.status as number).toBe(404);
    expect((refused.error?.value as { error?: string })?.error).toBe('workflows.not_found');
    expect(await workflow_spans(workflow_id)).toBe(0);
    expect(await workflow_rows(otelMetrics, workflow_id)).toBe(0);
  });
});

describe.each([...WORKFLOWS])('sample data for %s', (workflow) => {
  let workflow_id: string;
  let token: string;
  const add = () => add_sample_data(workflow_id, token, workflow);

  beforeEach(async () => {
    token = TEST_API_KEY;
    ({ workflow_id } = await create_test_workflow({ name: workflow }));
  });

  // A replay dates a week of rows up to now, and the files share one database: left behind, they
  // slow every later test that reads the last 7 days across workflows.
  afterEach(async () => {
    await db
      .delete(otelSpans)
      .where(sql`${otelSpans.attributes} ->> ${WORKFLOW_ID_ATTRIBUTE} = ${workflow_id}`);
    for (const table of [otelLogs, otelMetrics, otelMetricRollups]) {
      await db
        .delete(table)
        .where(
          sql`${table.resource_attributes} ->> ${RESOURCE_WORKFLOW_ATTRIBUTE} = ${workflow_id}`
        );
    }
  });

  test(
    'fills a workflow with spans, metrics and the rollups the charts read',
    async () => {
      const added = await add();

      expect(added.error).toBeNull();
      expect(added.data?.spans).toBeGreaterThan(0);
      expect(added.data?.metrics).toBeGreaterThan(0);
      expect(await workflow_rows(otelLogs, workflow_id)).toBe(added.data!.logs);

      // Metrics are stored twice: raw points, and five-minute rollups. The charts read only the
      // rollups, so a loader that wrote the points alone would leave every chart empty.
      expect(await workflow_rows(otelMetricRollups, workflow_id)).toBeGreaterThan(0);
    },
    REPLAY_TIMEOUT_MS
  );

  // The replay logic is the same for every fixture, so it is checked on the smallest. Portfolio's
  // replay takes ~9.5s on a CI runner; above, it is only proven to load and fill.
  if (workflow !== 'helloworld') return;

  test(
    'spreads the run across the week ending now, behind anything the user sends',
    async () => {
      await add();

      const [range] = await db
        .select({
          oldest: sql<string>`min(${otelSpans.start_time_unix_nano})`,
          newest: sql<string>`max(${otelSpans.start_time_unix_nano})`,
        })
        .from(otelSpans)
        .where(sql`${otelSpans.attributes} ->> ${WORKFLOW_ID_ATTRIBUTE} = ${workflow_id}`);

      const now = BigInt(Date.now()) * 1_000_000n;
      const oldest = BigInt(range!.oldest);
      const newest = BigInt(range!.newest);

      // The dashboard's default view is the last week, so the run has to land inside it wherever and
      // whenever the quickstart runs -- the fixture stores ages, never dates. Several days wide, so
      // the history reads as a week of use rather than one busy afternoon.
      expect(now - oldest).toBeLessThan(7n * NANOS_PER_DAY);
      expect(now - oldest).toBeGreaterThan(3n * NANOS_PER_DAY);
      // Every recorded span is older than the request the user just sent, so theirs reads as the
      // newest thing on the page rather than being buried in the middle of the history.
      expect(newest).toBeLessThan(now);
    },
    REPLAY_TIMEOUT_MS
  );

  test(
    'is repeatable: a second call replaces its own rows instead of duplicating them',
    async () => {
      const first = await add();
      const after_first = {
        spans: await workflow_spans(workflow_id),
        logs: await workflow_rows(otelLogs, workflow_id),
        metrics: await workflow_rows(otelMetrics, workflow_id),
        rollup_samples: await rollup_samples(workflow_id),
      };

      const second = await add();

      expect(second.error).toBeNull();
      expect(second.data).toEqual(first.data!);
      expect(await workflow_spans(workflow_id)).toBe(after_first.spans);
      expect(await workflow_rows(otelLogs, workflow_id)).toBe(after_first.logs);
      expect(await workflow_rows(otelMetrics, workflow_id)).toBe(after_first.metrics);
      expect(await rollup_samples(workflow_id)).toBe(after_first.rollup_samples);
    },
    REPLAY_TIMEOUT_MS
  );

  test(
    'never removes telemetry the workflow produced itself',
    async () => {
      await write_workflow_span(workflow_id, { span_id: `own-${crypto.randomUUID()}` });
      await add();
      // The replay deletes before it inserts. Its delete is the dangerous half: it runs against a
      // workflow full of the user's own traces, and must address only the rows it wrote itself.
      await add();

      const [own] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(otelSpans)
        .where(
          sql`${otelSpans.attributes} ->> ${WORKFLOW_ID_ATTRIBUTE} = ${workflow_id}
              and ${otelSpans.attributes} ->> ${SAMPLE_ATTRIBUTE} is distinct from 'true'`
        );
      expect(own!.n).toBe(1);
    },
    REPLAY_TIMEOUT_MS
  );
});
