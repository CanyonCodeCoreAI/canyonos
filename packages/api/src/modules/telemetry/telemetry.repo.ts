import { db } from '@api/db/client';
import { otelLogs, otelMetrics, otelSpans } from '@api/db/schema';

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

// A metric row binds 9 columns and a log row 11; both stay well under the 65535-parameter cap.
const APPEND_CHUNK_SIZE = 1000;

/**
 * Append every data point. Neither metrics nor logs carry a natural id to deduplicate on, so both
 * stores are plain observation logs: a retried export inserts the same rows twice.
 */
export async function insert_metrics(rows: readonly MetricRow[]): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += APPEND_CHUNK_SIZE) {
    await db.insert(otelMetrics).values(rows.slice(offset, offset + APPEND_CHUNK_SIZE));
  }
}

export async function insert_logs(rows: readonly LogRow[]): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += APPEND_CHUNK_SIZE) {
    await db.insert(otelLogs).values(rows.slice(offset, offset + APPEND_CHUNK_SIZE));
  }
}
