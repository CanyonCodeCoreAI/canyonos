// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { otelMetricRollups } from '@api/db/schema';

import type { MetricRow } from './telemetry.repo';

export const ROLLUP_SECONDS = 300;
export const ROLLUP_NANOS = BigInt(ROLLUP_SECONDS) * 1_000_000_000n;

/** The start of the five-minute UTC bucket a timestamp falls in. */
export const bucket_start_of = (time_unix_nano: bigint): bigint =>
  time_unix_nano - (time_unix_nano % ROLLUP_NANOS);

export type RollupRow = typeof otelMetricRollups.$inferInsert;

// The database tells series apart by its jsonb text, which ignores key order, so two points whose
// attributes differ only in order must land in one group too: otherwise one upsert would hit the
// same row twice and Postgres rejects the whole statement.
const key_sorted = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(key_sorted);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, nested]) => [key, key_sorted(nested)])
  );
};

const group_key = (row: MetricRow, bucket_start_unix_nano: bigint): string =>
  JSON.stringify([
    row.metric_name,
    row.service_name ?? null,
    key_sorted(row.resource_attributes ?? {}),
    key_sorted(row.data_point_attributes ?? {}),
    String(bucket_start_unix_nano),
  ]);

/**
 * One rollup row per metric, series and bucket of the given points. A single upsert may not touch
 * the same row twice, so the points are grouped here before they reach the database. The rows come
 * back in key order so concurrent exports lock shared rows in the same order and cannot deadlock.
 */
export function rollup_rows(rows: readonly MetricRow[]): RollupRow[] {
  const groups = new Map<string, RollupRow>();
  for (const row of rows) {
    const bucket_start_unix_nano = bucket_start_of(row.time_unix_nano);
    const key = group_key(row, bucket_start_unix_nano);
    const group = groups.get(key);
    if (!group) {
      groups.set(key, {
        metric_name: row.metric_name,
        metric_type: row.metric_type,
        metric_unit: row.metric_unit,
        service_name: row.service_name,
        resource_attributes: row.resource_attributes,
        data_point_attributes: row.data_point_attributes,
        bucket_start_unix_nano,
        sum: row.value,
        count: 1,
        min: row.value,
        max: row.value,
        last_value: row.value,
        last_time_unix_nano: row.time_unix_nano,
      });
      continue;
    }
    group.sum += row.value;
    group.count += 1;
    group.min = Math.min(group.min, row.value);
    group.max = Math.max(group.max, row.value);
    if (row.time_unix_nano >= group.last_time_unix_nano) {
      group.last_value = row.value;
      group.last_time_unix_nano = row.time_unix_nano;
    }
  }
  return [...groups.keys()].sort().map((key) => groups.get(key)!);
}
