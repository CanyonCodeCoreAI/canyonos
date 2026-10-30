// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { lt, sql } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';

import { db } from '@api/db/client';
import { otelMetricRollups, otelMetrics } from '@api/db/schema';
import { config } from '@core/env';
import { LOG_DOMAINS, logger } from '@core/logger';

// Small batches keep each delete's locks and WAL short, so ingest never waits on a prune.
const RETENTION_BATCH = 10_000;
const RETENTION_INTERVAL_MS = 60 * 60 * 1000;
const NANOS_PER_DAY = 86_400n * 1_000_000_000n;

const retention_logger = logger.child({ domain: LOG_DOMAINS.DB });

const cutoff_unix_nano = (now: Date, days: number): bigint =>
  BigInt(now.getTime()) * 1_000_000n - BigInt(days) * NANOS_PER_DAY;

async function delete_older_than(
  table: PgTable,
  id: PgColumn,
  time: PgColumn,
  cutoff: bigint
): Promise<number> {
  let deleted = 0;
  for (;;) {
    const batch = await db.execute(
      sql`delete from ${table} where ${id} in (select ${id} from ${table} where ${lt(time, cutoff)} limit ${RETENTION_BATCH})`
    );
    if (batch.count === 0) return deleted;
    deleted += batch.count;
  }
}

/** Deletes raw ticks past the raw retention and rollups past the rollup retention, as of `now`. */
export async function prune_expired_metrics(
  now = new Date()
): Promise<{ raw_deleted: number; rollups_deleted: number }> {
  const raw_deleted = await delete_older_than(
    otelMetrics,
    otelMetrics.id,
    otelMetrics.time_unix_nano,
    cutoff_unix_nano(now, config.metrics.rawRetentionDays)
  );
  const rollups_deleted = await delete_older_than(
    otelMetricRollups,
    otelMetricRollups.id,
    otelMetricRollups.bucket_start_unix_nano,
    cutoff_unix_nano(now, config.metrics.rollupRetentionDays)
  );
  return { raw_deleted, rollups_deleted };
}

/** Prunes now, then hourly; a failed run is logged and the next one tries again. */
export function start_metrics_retention(): void {
  const run = () =>
    prune_expired_metrics()
      .then((deleted) => retention_logger.info('Pruned expired metrics', deleted))
      .catch((error: unknown) =>
        retention_logger.warn('Could not prune expired metrics', { error })
      );
  void run();
  setInterval(run, RETENTION_INTERVAL_MS).unref();
}
