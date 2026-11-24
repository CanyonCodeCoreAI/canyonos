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
  spanTotalTokens,
  spanWorkflowId,
} from '../metrics/metrics.sql';

export interface FleetWorkflowRow {
  readonly workflow_id: string;
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
  // Count span IDs so the left-join row keeps zero-activity workflows at zero. Only the workflows
  // of `workflow_group_ids`.
  async fleet_workflows(
    range: TimeRange,
    workflow_group_ids: readonly string[]
  ): Promise<FleetWorkflowRow[]> {
    if (workflow_group_ids.length === 0) return [];
    const in_groups = sql.join(
      workflow_group_ids.map((id) => sql`${id}::uuid`),
      sql`, `
    );
    const rows = await db.execute(sql`
      with scoped as (${fleetRequestSpans(range)})
      select
        p.id::text as workflow_id,
        p.name,
        p.created_at::text as created_at,
        count(distinct s.trace_id)::int as request_count,
        count(s.span_id)::int as block_count,
        count(s.span_id) filter (where ${sql.raw(spanFailed('s'))})::int as failed_block_count,
        coalesce(sum(${sql.raw(spanTotalTokens('s'))}), 0)::float8 as tokens,
        coalesce(sum(${sql.raw(spanCost('s'))}), 0)::numeric(20, 10)::text as total_cost,
        avg(${sql.raw(spanDurationMs('s'))})::float8 as avg_latency_ms
      from workflows p
      left join scoped s on ${sql.raw(spanWorkflowId('s'))} = p.id::text
      where p.workflow_group_id in (${in_groups})
      group by p.id, p.name, p.created_at
      order by p.created_at, p.id
    `);
    return rows as unknown as FleetWorkflowRow[];
  },
};
