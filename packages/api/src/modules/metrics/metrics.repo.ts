// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';

import { db } from '@api/db/client';
import { timeGrid } from '@core/time-range';
import type { GridQuery, TimeRange } from '@core/time-range';

import { distribution_sql } from './metrics.distribution';
import {
  isModelSpan,
  projectRequestSpans,
  requestStart,
  spanAgentId,
  spanCacheHitRatio,
  spanCost,
  spanDurationMs,
  spanErrorCount,
  spanFailed,
  spanModel,
  spanServerCost,
  spanTokenCost,
  spanTotalTokens,
} from './metrics.sql';
import { DistributionMetricSchema } from './metrics.types';
import type {
  DistributionMetric,
  DistributionStats,
  MetricsAgentDetails,
  MetricsAgentTimeseries,
  MetricsBlocks,
  MetricsDistribution,
  MetricsKpi,
  MetricsKpis,
  MetricsTimeseries,
  RunRatePer,
} from './metrics.types';

const AGENT_HISTOGRAM_BUCKETS = 12;

/**
 * A block's wasted spend: a failed block bought nothing, and a block that recovered from `n` errors
 * paid for `n` of the `n + 1` attempts it made. A block with no reported cost is excluded.
 */
const recoverable_cost = (alias: string): string => `(case
        when ${spanFailed(alias)} then ${spanCost(alias)}
        when ${spanErrorCount(alias)} > 0
          then ${spanCost(alias)} * ${spanErrorCount(alias)} / (${spanErrorCount(alias)} + 1)
        else 0
      end)`;

/**
 * The name is the identity; `gen_ai.agent.id` addresses it, taken only where every reporting span
 * agrees on one. `replica_count` is how many ids the store reported, so 0 means name-only.
 */
const AGENTS_CTE = `agents as (
    select
      s.name,
      coalesce(
        case when count(distinct ${spanAgentId('s')}) = 1 then min(${spanAgentId('s')}) end,
        s.name
      ) as agent_id,
      count(distinct ${spanAgentId('s')})::int as replica_count
    from scoped s
    group by s.name
  )`;

// Cost averages divide by the costed count: a block with no reported cost is not a free block.
const KPI_COLUMNS = [
  `count(distinct s.trace_id)::int as request_count`,
  `count(*)::int as block_count`,
  `count(*) filter (where ${spanFailed('s')})::int as failed_block_count`,
  `coalesce(sum(${spanTotalTokens('s')}), 0)::float8 as tokens`,
  `(coalesce(sum(${spanTotalTokens('s')}), 0)::float8
    / nullif(count(*), 0)) as per_block_tokens`,
  `coalesce(sum(${spanServerCost('s')}), 0)::numeric(20, 10)::text as harness_cost`,
  `coalesce(sum(${spanTokenCost('s')}), 0)::numeric(20, 10)::text as llm_cost`,
  `coalesce(sum(${spanCost('s')}), 0)::numeric(20, 10)::text as total_cost`,
  `coalesce(sum(${recoverable_cost('s')}) filter (where ${spanCost('s')} is not null), 0)
    ::numeric(20, 10)::text as recoverable_cost`,
  `(avg(${spanCost('s')}) filter (where ${spanCost('s')} is not null))
    ::numeric(20, 10)::text as per_block_cost`,
  `(avg(${spanDurationMs('s')}))::float8 as per_block_latency_ms`,
  `count(*) filter (where ${spanCost('s')} is not null)::int as costed_block_count`,
  `count(distinct s.trace_id) filter (where ${spanCost('s')} is not null)
    ::int as costed_request_count`,
].join(',\n      ');

// Averaged over per-request sums, never total_cost / request_count.
const KPI_COST_PER_REQUEST_COLUMN = `(select avg(q.cost)::numeric(20, 10)::text
      from (
        select s.trace_id, sum(${spanCost('s')}) as cost
        from scoped s
        where ${spanCost('s')} is not null
        group by s.trace_id
      ) q
    ) as per_costed_request_cost`;

const SECONDS_PER: Record<RunRatePer, number> = { hour: 3_600, day: 86_400 };

const run_rate_per = ({ from, to }: TimeRange): RunRatePer =>
  Date.parse(to) - Date.parse(from) <= SECONDS_PER.day * 1000 ? 'hour' : 'day';

const run_rate_column = (range: TimeRange, per: RunRatePer): SQL => {
  const range_seconds = (Date.parse(range.to) - Date.parse(range.from)) / 1000;
  return sql`(case
      when count(*) > 0 and count(${sql.raw(spanCost('s'))}) = 0 then null
      else (coalesce(sum(${sql.raw(spanCost('s'))}), 0) * ${SECONDS_PER[per]}::numeric
        / ${range_seconds}::numeric)::numeric(20, 10)::text
    end) as run_rate`;
};

// Each request lands whole in the bucket it started in, so the points sum to the KPI totals.
const timeseries_sql = ({
  source,
  query,
  prelude,
}: {
  /** Spans read through `projectRequestSpans`, which carry `request_start_unix_nano`. */
  source: string;
  query: GridQuery;
  /** Already comma-terminated: this statement owns its own `with`. */
  prelude?: SQL;
}): SQL => {
  const grid = timeGrid(query);
  return sql`
    with ${prelude ?? sql.empty()}slots as (${grid.slots}),
    per_bucket as (
      select
        ${grid.index(requestStart('s'))} as bucket,
        count(distinct s.trace_id)::int as request_count,
        count(*)::int as block_count,
        coalesce(sum(${sql.raw(spanTotalTokens('s'))}), 0)::float8 as tokens,
        sum(${sql.raw(spanTokenCost('s'))}) as llm_cost,
        sum(${sql.raw(spanServerCost('s'))}) as harness_cost,
        sum(${sql.raw(spanCost('s'))}) as total_cost
      from ${sql.raw(source)}
      group by 1
    )
    select
      ${grid.bucket_seconds}::float8 as bucket_seconds,
      json_agg(json_build_object(
        'start_at', sl.bucket_start,
        'llm_cost', coalesce(p.llm_cost, 0)::numeric(20, 10)::text,
        'harness_cost', coalesce(p.harness_cost, 0)::numeric(20, 10)::text,
        'total_cost', coalesce(p.total_cost, 0)::numeric(20, 10)::text,
        'request_count', coalesce(p.request_count, 0),
        'block_count', coalesce(p.block_count, 0),
        'tokens', coalesce(p.tokens, 0)
      ) order by sl.b) as points
    from slots sl
    left join per_bucket p on p.bucket = sl.b
  `;
};

const block_aggregates = (): string =>
  [
    `coalesce(sum(${spanCost('s')}), 0)::numeric(20, 10)::text as cost`,
    `coalesce(sum(${spanTokenCost('s')}), 0)::numeric(20, 10)::text as llm_cost`,
    `coalesce(sum(${spanServerCost('s')}), 0)::numeric(20, 10)::text as harness_cost`,
    `coalesce(sum(${recoverable_cost('s')}) filter (where ${spanCost('s')} is not null), 0)
      ::numeric(20, 10)::text as recoverable_cost`,
    `count(*)::int as block_count`,
    `coalesce(sum(${spanTotalTokens('s')}), 0)::float8 as token_count`,
    `((count(*) filter (where ${spanErrorCount('s')} > 0))::float8
      / nullif(count(*), 0)) as retry_rate`,
    `((count(*) filter (where ${spanFailed('s')}))::float8 / nullif(count(*), 0)) as failed_rate`,
    `(percentile_cont(0.95) within group (order by ${spanDurationMs('s')}))::float8
      as p95_latency_ms`,
    `avg(${spanCacheHitRatio('s')})::float8 as cache_hit_ratio`,
  ].join(',\n        ');

const AGENT_DISTRIBUTIONS = DistributionMetricSchema.options.map((metric) => ({
  metric,
  ...distribution_sql({ metric, source: 'agent_rows s', buckets: AGENT_HISTOGRAM_BUCKETS }),
}));

const AGENT_DISTRIBUTION_CTES = AGENT_DISTRIBUTIONS.map((d) => d.ctes).join(',\n      ');
const AGENT_DISTRIBUTION_COLUMNS = AGENT_DISTRIBUTIONS.map((d) => `${d.json} as ${d.metric}`).join(
  ',\n        '
);

export const metrics_repo = {
  async kpis_by_project(project_id: string, range: TimeRange): Promise<MetricsKpis> {
    const per = run_rate_per(range);
    const rows = await db.execute(sql`
      with scoped as (${projectRequestSpans(project_id, range)})
      select now()::text as generated_at,
        ${sql.raw(KPI_COLUMNS)},
        ${sql.raw(KPI_COST_PER_REQUEST_COLUMN)},
        ${run_rate_column(range, per)}
      from scoped s
    `);
    const row = (
      rows as unknown as [MetricsKpi & { generated_at: string; run_rate: string | null }]
    )[0];
    return { project_id, from: range.from, to: range.to, ...row, run_rate_per: per };
  },

  async distribution_by_project(
    project_id: string,
    metric: DistributionMetric,
    range: TimeRange,
    buckets: number
  ): Promise<MetricsDistribution> {
    const distribution = distribution_sql({ metric, source: 'scoped s', buckets });
    const rows = await db.execute(sql`
      with scoped as (${projectRequestSpans(project_id, range)}),
      ${sql.raw(distribution.ctes)}
      select ${sql.raw(distribution.json)} as stats
    `);
    const row = (rows as unknown as [{ stats: DistributionStats }])[0];
    return { project_id, metric, ...range, ...row.stats };
  },

  async timeseries_by_project(project_id: string, query: GridQuery): Promise<MetricsTimeseries> {
    const rows = await db.execute(
      timeseries_sql({
        prelude: sql`scoped as (${projectRequestSpans(project_id, query)}), `,
        source: 'scoped s',
        query,
      })
    );
    const row = (
      rows as unknown as [{ bucket_seconds: number; points: MetricsTimeseries['points'] }]
    )[0];
    return {
      project_id,
      from: query.from,
      to: query.to,
      bucket_seconds: row.bucket_seconds,
      points: row.points,
    };
  },

  async blocks_by_project(project_id: string, range: TimeRange): Promise<MetricsBlocks> {
    const rows = await db.execute(sql`
      with scoped as (${projectRequestSpans(project_id, range)}),
      ${sql.raw(AGENTS_CTE)},
      grouped as (
        select
          a.agent_id,
          s.name as label,
          ${sql.raw(spanModel('s'))} as model,
          (case when bool_or(${sql.raw(isModelSpan('s'))}) then 'model' else 'harness' end) as kind,
          ${sql.raw(block_aggregates())}
        from scoped s
        join agents a on a.name = s.name
        group by a.agent_id, s.name, ${sql.raw(spanModel('s'))}
      )
      select
        coalesce((select sum(cost::numeric) from grouped), 0)::numeric(20, 10)::text as total_cost,
        coalesce((
          select json_agg(json_build_object(
            'agent_id', g.agent_id,
            'model', g.model,
            'label', g.label,
            'kind', g.kind,
            'cost', g.cost,
            'llm_cost', g.llm_cost,
            'harness_cost', g.harness_cost,
            'recoverable_cost', g.recoverable_cost,
            'block_count', g.block_count,
            'token_count', g.token_count,
            'retry_rate', g.retry_rate,
            'failed_rate', g.failed_rate,
            'p95_latency_ms', g.p95_latency_ms,
            'cache_hit_ratio', g.cache_hit_ratio
          ) order by g.cost::numeric desc, g.block_count desc, g.label, g.model)
          from grouped g
        ), '[]'::json) as blocks
    `);
    const row = (rows as unknown as [{ total_cost: string; blocks: MetricsBlocks['blocks'] }])[0];
    return { project_id, ...range, total_cost: row.total_cost, blocks: row.blocks };
  },

  async agent_details_by_project(
    project_id: string,
    agent_id: string,
    query: GridQuery
  ): Promise<MetricsAgentDetails | null> {
    const rows = await db.execute(sql`
      with scoped as (${projectRequestSpans(project_id, query)}),
      ${sql.raw(AGENTS_CTE)},
      agent_rows as (
        select s.*
        from scoped s
        join agents a on a.name = s.name
        where a.agent_id = ${agent_id}
      ),
      project_totals as (
        select
          count(distinct s.trace_id)::int as request_count,
          coalesce(sum(${sql.raw(spanCost('s'))}), 0)::numeric(20, 10)::text as total_cost
        from scoped s
      ),
      agent_summary as (
        select
          count(distinct s.trace_id)::int as request_count,
          count(distinct ${sql.raw(spanAgentId('s'))})::int as replica_count,
          ${sql.raw(block_aggregates())}
        from agent_rows s
      ),
      series as (${timeseries_sql({ source: 'agent_rows s', query })}),
      ${sql.raw(AGENT_DISTRIBUTION_CTES)}
      select
        (
          select s.name from agent_rows s
          group by s.name
          order by count(*) desc, s.name
          limit 1
        ) as label,
        pt.request_count as project_request_count,
        pt.total_cost as project_total_cost,
        a.request_count,
        a.replica_count,
        a.cost,
        a.llm_cost,
        a.harness_cost,
        a.recoverable_cost,
        a.block_count,
        a.token_count,
        a.retry_rate,
        a.failed_rate,
        a.p95_latency_ms,
        a.cache_hit_ratio,
        ts.bucket_seconds,
        ts.points,
        ${sql.raw(AGENT_DISTRIBUTION_COLUMNS)}
      from agent_summary a
      cross join project_totals pt
      cross join series ts
    `);
    const row = (
      rows as unknown as [
        | (Record<DistributionMetric, DistributionStats> & {
            label: string | null;
            project_request_count: number;
            project_total_cost: string;
            request_count: number;
            replica_count: number;
            cost: string;
            llm_cost: string;
            harness_cost: string;
            recoverable_cost: string;
            block_count: number;
            token_count: number;
            retry_rate: number | null;
            failed_rate: number | null;
            p95_latency_ms: number | null;
            cache_hit_ratio: number | null;
            bucket_seconds: number;
            points: MetricsAgentTimeseries['points'];
          })
        | undefined,
      ]
    )[0];

    if (!row || row.block_count === 0 || row.label === null) return null;

    return {
      project_id,
      agent_id,
      label: row.label,
      from: query.from,
      to: query.to,
      project: {
        request_count: row.project_request_count,
        total_cost: row.project_total_cost,
      },
      agent: {
        request_count: row.request_count,
        replica_count: row.replica_count,
        cost: row.cost,
        llm_cost: row.llm_cost,
        harness_cost: row.harness_cost,
        recoverable_cost: row.recoverable_cost,
        block_count: row.block_count,
        token_count: row.token_count,
        retry_rate: row.retry_rate,
        failed_rate: row.failed_rate,
        p95_latency_ms: row.p95_latency_ms,
        cache_hit_ratio: row.cache_hit_ratio,
      },
      timeseries: { bucket_seconds: row.bucket_seconds, points: row.points },
      tokens_per_request: row.tokens_per_request,
      cost_per_request: row.cost_per_request,
      latency: row.latency,
    };
  },
};
