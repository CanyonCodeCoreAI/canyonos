// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { sql } from 'drizzle-orm';

import { db } from '@api/db/client';
import { otelLogs, otelMetricRollups, otelMetrics, otelSpans } from '@api/db/schema';

import { rollup_rows } from './telemetry.rollup';

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type SpanRow = typeof otelSpans.$inferInsert;
export type MetricRow = typeof otelMetrics.$inferInsert;
export type LogRow = typeof otelLogs.$inferInsert;

// Postgres binds at most 65535 parameters per statement and a span row binds 13, so a large export
// is split rather than rejected. `BatchSpanProcessor` defaults to 512 spans per export.
const INSERT_CHUNK_SIZE = 500;

/** A re-sent span is a no-op: the exporter marks a span sent when queued, so it can arrive twice. */
export async function insert_spans(rows: readonly SpanRow[]): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += INSERT_CHUNK_SIZE) {
    const chunk = rows.slice(offset, offset + INSERT_CHUNK_SIZE);
    await db.insert(otelSpans).values(chunk).onConflictDoNothing({ target: otelSpans.span_id });
  }
}

// A metric row binds 9 columns, a rollup row 13 and a log row 11; all stay well under the
// 65535-parameter cap.
const APPEND_CHUNK_SIZE = 1000;

/**
 * Append every data point and fold it into its five-minute rollup, in one transaction so the two
 * tiers never disagree. Neither metrics nor logs carry a natural id to deduplicate on, so both
 * stores are plain observation logs: a retried export inserts the same rows twice and adds to the
 * rollup twice.
 */
export async function insert_metrics(rows: readonly MetricRow[]): Promise<void> {
  if (rows.length === 0) return;
  await db.transaction((tx) => append_metrics(tx, rows));
}

/** The two-tier append inside a caller's transaction. */
export async function append_metrics(tx: Tx, rows: readonly MetricRow[]): Promise<void> {
  const rollups = rollup_rows(rows);
  for (let offset = 0; offset < rows.length; offset += APPEND_CHUNK_SIZE) {
    await tx.insert(otelMetrics).values(rows.slice(offset, offset + APPEND_CHUNK_SIZE));
  }
  for (let offset = 0; offset < rollups.length; offset += APPEND_CHUNK_SIZE) {
    await tx
      .insert(otelMetricRollups)
      .values(rollups.slice(offset, offset + APPEND_CHUNK_SIZE))
      .onConflictDoUpdate({
        target: [
          otelMetricRollups.metric_name,
          otelMetricRollups.series_key,
          otelMetricRollups.bucket_start_unix_nano,
        ],
        set: {
          sum: sql`${otelMetricRollups.sum} + excluded.sum`,
          count: sql`${otelMetricRollups.count} + excluded.count`,
          min: sql`least(${otelMetricRollups.min}, excluded.min)`,
          max: sql`greatest(${otelMetricRollups.max}, excluded.max)`,
          last_value: sql`case when excluded.last_time_unix_nano >= ${otelMetricRollups.last_time_unix_nano} then excluded.last_value else ${otelMetricRollups.last_value} end`,
          last_time_unix_nano: sql`greatest(${otelMetricRollups.last_time_unix_nano}, excluded.last_time_unix_nano)`,
        },
      });
  }
}

export async function insert_logs(rows: readonly LogRow[]): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += APPEND_CHUNK_SIZE) {
    await db.insert(otelLogs).values(rows.slice(offset, offset + APPEND_CHUNK_SIZE));
  }
}
