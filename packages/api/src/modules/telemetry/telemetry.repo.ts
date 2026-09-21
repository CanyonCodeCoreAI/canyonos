import { db } from '@api/db/client';
import { otelSpans } from '@api/db/schema';

export type SpanRow = typeof otelSpans.$inferInsert;

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
