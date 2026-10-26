// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { sql } from 'drizzle-orm';

import { db } from '@api/db/client';
import type { TimeRange } from '@core/time-range';

import {
  fleetRequestSpans,
  spanCost,
  spanDurationMs,
  spanFailed,
  spanProjectId,
  spanTotalTokens,
} from '../metrics/metrics.sql';

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
  async fleet_projects(range: TimeRange): Promise<FleetProjectRow[]> {
    const rows = await db.execute(sql`
      with scoped as (${fleetRequestSpans(range)})
      select
        p.id::text as project_id,
        p.name,
        p.created_at::text as created_at,
        count(distinct s.trace_id)::int as request_count,
        count(s.span_id)::int as block_count,
        count(s.span_id) filter (where ${sql.raw(spanFailed('s'))})::int as failed_block_count,
        coalesce(sum(${sql.raw(spanTotalTokens('s'))}), 0)::float8 as tokens,
        coalesce(sum(${sql.raw(spanCost('s'))}), 0)::numeric(20, 10)::text as total_cost,
        avg(${sql.raw(spanDurationMs('s'))})::float8 as avg_latency_ms
      from projects p
      left join scoped s on ${sql.raw(spanProjectId('s'))} = p.id::text
      group by p.id, p.name, p.created_at
      order by p.created_at, p.id
    `);
    return rows as unknown as FleetProjectRow[];
  },
};
