import { sql } from 'drizzle-orm';

import { db } from '@api/db/client';
import { otelSpans } from '@api/db/schema';

import { window_floor_nanos } from '../metrics/metrics.scope';
import {
  spanCost,
  spanDurationMs,
  spanFailed,
  spanProjectId,
  spanTotalTokens,
} from '../metrics/metrics.sql';
import type { MetricsWindow } from '../metrics/metrics.types';

export interface FleetProjectRow {
  readonly project_id: string;
  readonly name: string;
  readonly created_at: string;
  readonly request_count: number;
  readonly block_count: number;
  readonly failed_block_count: number;
  readonly tokens: number;
  readonly total_cost: string;
  readonly avg_latency_ms: number | null;
}

export const resources_repo = {
  // Count span IDs so the left-join row keeps zero-activity projects at zero.
  async fleet_projects(time_window: MetricsWindow): Promise<FleetProjectRow[]> {
    const rows = await db.execute(sql`
      select
        p.id::text as project_id,
        p.name,
        p.created_at::text as created_at,
        count(distinct s.trace_id)::int as request_count,
        count(s.span_id)::int as block_count,
        count(s.span_id) filter (where ${sql.raw(spanFailed('s'))})::int as failed_block_count,
        coalesce(sum(${sql.raw(spanTotalTokens('s'))}), 0)::float8 as tokens,
        coalesce(sum(${sql.raw(spanCost('s'))}), 0)::numeric(14, 6)::text as total_cost,
        avg(${sql.raw(spanDurationMs('s'))})::float8 as avg_latency_ms
      from projects p
      left join ${otelSpans} s
        on ${sql.raw(spanProjectId('s'))} = p.id::text
        and s.start_time_unix_nano >= ${sql.raw(window_floor_nanos(time_window))}
      group by p.id, p.name, p.created_at
      order by p.created_at, p.id
    `);
    return rows as unknown as FleetProjectRow[];
  },
};
