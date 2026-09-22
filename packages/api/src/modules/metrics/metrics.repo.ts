import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';

import { db } from '@api/db/client';

import { distribution_sql } from './metrics.distribution';
import { NO_FLOOR, window_floor_nanos, WINDOW_INTERVALS } from './metrics.scope';
import {
  isModelSpan,
  projectSpans,
  spanAgentId,
  spanCacheHitRatio,
  spanCost,
  spanDurationMs,
  spanErrorCount,
  spanFailed,
  spanModel,
  spanServerCost,
  spanStart,
  spanTokenCost,
  spanTotalTokens,
} from './metrics.sql';
import { DistributionMetricSchema } from './metrics.types';
import type {
  DistributionMetric,
  DistributionStats,
  KpiWindow,
  MetricsAgentDetails,
  MetricsAgentTimeseries,
  MetricsBlocks,
  MetricsDistribution,
  MetricsFlow,
  MetricsKpis,
  MetricsTimeseries,
  MetricsWindow,
} from './metrics.types';

const WINDOW_KEYS = Object.keys(WINDOW_INTERVALS) as MetricsWindow[];

const SCAN_FLOOR = window_floor_nanos('1q');

// `parent_span_id` has no foreign key and the producer may write a cycle, which would otherwise
// make the recursion non-terminating.
const MAX_ANCESTRY_HOPS = 64;
const AGENT_HISTOGRAM_BUCKETS = 12;

const GRID_UNITS: Record<MetricsWindow, 'hour' | 'day'> = {
  '1d': 'hour',
  '7d': 'day',
  '30d': 'day',
  '1q': 'day',
};

const ENTRY_NODE_ID = 'entry';
const ENTRY_NODE_LABEL = 'Request';
const AGENT_NODE_PREFIX = 'agent:';

const lit = (value: string): SQL => sql.raw(`'${value}'`);

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

const window_filter = (key: MetricsWindow, extra?: string): string => {
  const conditions = [
    key === '1q' ? undefined : `s.start_time_unix_nano >= ${window_floor_nanos(key)}`,
    extra,
  ].filter(Boolean);
  return conditions.length === 0 ? '' : ` filter (where ${conditions.join(' and ')})`;
};

// Cost averages divide by the costed count: a block with no reported cost is not a free block.
const kpi_columns = (key: MetricsWindow): string => {
  const f = window_filter(key);
  const priced = window_filter(key, `${spanCost('s')} is not null`);
  return [
    `count(distinct s.trace_id)${f}::int as "request_count_${key}"`,
    `count(*)${f}::int as "block_count_${key}"`,
    `count(*)${window_filter(key, spanFailed('s'))}::int as "failed_block_count_${key}"`,
    `coalesce(sum(${spanTotalTokens('s')})${f}, 0)::float8 as "tokens_${key}"`,
    `(coalesce(sum(${spanTotalTokens('s')})${f}, 0)::float8
        / nullif(count(*)${f}, 0)) as "per_block_tokens_${key}"`,
    `coalesce(sum(${spanServerCost('s')})${f}, 0)::numeric(14, 6)::text as "harness_cost_${key}"`,
    `coalesce(sum(${spanTokenCost('s')})${f}, 0)::numeric(14, 6)::text as "llm_cost_${key}"`,
    `coalesce(sum(${spanCost('s')})${f}, 0)::numeric(14, 6)::text as "total_cost_${key}"`,
    `coalesce(sum(${recoverable_cost('s')})${priced}, 0)
        ::numeric(14, 6)::text as "recoverable_cost_${key}"`,
    `(avg(${spanCost('s')})${priced})::numeric(14, 6)::text as "per_block_cost_${key}"`,
    `(avg(${spanDurationMs('s')})${f})::float8 as "per_block_latency_ms_${key}"`,
    `count(*)${priced}::int as "costed_block_count_${key}"`,
    `count(distinct s.trace_id)${priced}::int as "costed_request_count_${key}"`,
  ].join(',\n      ');
};

// Averaged over per-request sums, never `total_cost / request_count`: that would spread reported
// dollars across requests that priced nothing.
const kpi_cost_per_request_column = (key: MetricsWindow): string => {
  const floor = key === '1q' ? '' : ` and s.start_time_unix_nano >= ${window_floor_nanos(key)}`;
  return `(select avg(q.cost)::numeric(14, 6)::text
      from (
        select s.trace_id, sum(${spanCost('s')}) as cost
        from scoped s
        where ${spanCost('s')} is not null${floor}
        group by s.trace_id
      ) q
    ) as "per_costed_request_cost_${key}"`;
};

// The grid drives the output, so a quiet bucket is an explicit zero. It ends at the next calendar
// boundary after now, which makes the newest bucket partial by design.
const timeseries_sql = ({
  source,
  interval,
  unit,
  buckets,
  time_zone,
  prelude,
}: {
  source: string;
  interval: string;
  unit: 'hour' | 'day';
  buckets: number;
  time_zone: SQL | string;
  /** Already comma-terminated: this statement owns its own `with`. */
  prelude?: SQL;
}): SQL => sql`
  with ${prelude ?? sql.empty()}grid as (
    select
      e.end_local - interval '${sql.raw(interval)}' as start_local,
      extract(epoch from interval '${sql.raw(interval)}')::float8 / ${sql.raw(String(buckets))}::int
        as bucket_seconds
    from (
      select date_trunc('${sql.raw(unit)}', now() at time zone ${time_zone})
        + interval '1 ${sql.raw(unit)}' as end_local
    ) e
  ),
  per_bucket as (
    select
      least(
        floor(
          extract(epoch from ((${sql.raw(spanStart('s'))} at time zone ${time_zone}) - g.start_local))::float8
            / g.bucket_seconds
        )::int + 1,
        ${sql.raw(String(buckets))}::int
      ) as bucket,
      count(distinct s.trace_id)::int as request_count,
      count(*)::int as block_count,
      coalesce(sum(${sql.raw(spanTotalTokens('s'))}), 0)::float8 as tokens,
      sum(${sql.raw(spanTokenCost('s'))}) as llm_cost,
      sum(${sql.raw(spanServerCost('s'))}) as harness_cost,
      sum(${sql.raw(spanCost('s'))}) as total_cost
    from ${sql.raw(source)} cross join grid g
    where ${sql.raw(spanStart('s'))} >= g.start_local at time zone ${time_zone}
    group by 1
  )
  select
    g.bucket_seconds,
    (
      select json_agg(json_build_object(
        'start_at', (
          g.start_local + make_interval(secs => (b - 1) * g.bucket_seconds)
        ) at time zone ${time_zone},
        'llm_cost', coalesce(p.llm_cost, 0)::numeric(14, 6)::text,
        'harness_cost', coalesce(p.harness_cost, 0)::numeric(14, 6)::text,
        'total_cost', coalesce(p.total_cost, 0)::numeric(14, 6)::text,
        'request_count', coalesce(p.request_count, 0),
        'block_count', coalesce(p.block_count, 0),
        'tokens', coalesce(p.tokens, 0)
      ) order by b)
      from generate_series(1, ${sql.raw(String(buckets))}::int) b
      left join per_bucket p on p.bucket = b
    ) as points
  from grid g
`;

const block_aggregates = (): string =>
  [
    `coalesce(sum(${spanCost('s')}), 0)::numeric(14, 6)::text as cost`,
    `coalesce(sum(${spanTokenCost('s')}), 0)::numeric(14, 6)::text as llm_cost`,
    `coalesce(sum(${spanServerCost('s')}), 0)::numeric(14, 6)::text as harness_cost`,
    `coalesce(sum(${recoverable_cost('s')}) filter (where ${spanCost('s')} is not null), 0)
      ::numeric(14, 6)::text as recoverable_cost`,
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

type KpiRow = Record<string, number | string | null>;

export const metrics_repo = {
  async kpis_by_project(project_id: string): Promise<MetricsKpis> {
    const rows = await db.execute(sql`
      with scoped as (${projectSpans(project_id, SCAN_FLOOR)})
      select now()::text as generated_at,
        ${sql.raw(WINDOW_KEYS.map(kpi_columns).join(',\n      '))},
        ${sql.raw(WINDOW_KEYS.map(kpi_cost_per_request_column).join(',\n      '))}
      from scoped s
    `);
    const row = (rows as unknown as [KpiRow])[0];

    const time_window = (key: MetricsWindow): KpiWindow => ({
      request_count: row[`request_count_${key}`] as number,
      block_count: row[`block_count_${key}`] as number,
      failed_block_count: row[`failed_block_count_${key}`] as number,
      tokens: row[`tokens_${key}`] as number,
      per_block_tokens: row[`per_block_tokens_${key}`] as number | null,
      harness_cost: row[`harness_cost_${key}`] as string,
      llm_cost: row[`llm_cost_${key}`] as string,
      total_cost: row[`total_cost_${key}`] as string,
      recoverable_cost: row[`recoverable_cost_${key}`] as string,
      per_block_cost: row[`per_block_cost_${key}`] as string | null,
      per_block_latency_ms: row[`per_block_latency_ms_${key}`] as number | null,
      costed_block_count: row[`costed_block_count_${key}`] as number,
      costed_request_count: row[`costed_request_count_${key}`] as number,
      per_costed_request_cost: row[`per_costed_request_cost_${key}`] as string | null,
    });

    return {
      project_id,
      generated_at: row.generated_at as string,
      windows: {
        '1d': time_window('1d'),
        '7d': time_window('7d'),
        '30d': time_window('30d'),
        '1q': time_window('1q'),
      },
    };
  },

  async distribution_by_project(
    project_id: string,
    metric: DistributionMetric,
    time_window: MetricsWindow,
    buckets: number
  ): Promise<MetricsDistribution> {
    const distribution = distribution_sql({ metric, source: 'scoped s', buckets });
    const rows = await db.execute(sql`
      with scoped as (${projectSpans(project_id, window_floor_nanos(time_window))}),
      ${sql.raw(distribution.ctes)}
      select ${sql.raw(distribution.json)} as stats
    `);
    const row = (rows as unknown as [{ stats: DistributionStats }])[0];
    return { project_id, metric, time_window, ...row.stats };
  },

  async timeseries_by_project(
    project_id: string,
    time_window: MetricsWindow,
    buckets: number,
    time_zone: string
  ): Promise<MetricsTimeseries> {
    const rows = await db.execute(
      timeseries_sql({
        prelude: sql`scoped as (${projectSpans(project_id, window_floor_nanos(time_window))}), `,
        source: 'scoped s',
        interval: WINDOW_INTERVALS[time_window],
        unit: GRID_UNITS[time_window],
        buckets,
        time_zone: sql`${time_zone}`,
      })
    );
    const row = (
      rows as unknown as [{ bucket_seconds: number; points: MetricsTimeseries['points'] }]
    )[0];
    return {
      project_id,
      time_window,
      bucket_seconds: row.bucket_seconds,
      points: row.points,
    };
  },

  async blocks_by_project(project_id: string, time_window: MetricsWindow): Promise<MetricsBlocks> {
    const rows = await db.execute(sql`
      with scoped as (${projectSpans(project_id, window_floor_nanos(time_window))}),
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
        coalesce((select sum(cost::numeric) from grouped), 0)::numeric(14, 6)::text as total_cost,
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
    return {
      project_id,
      time_window,
      total_cost: row.total_cost,
      blocks: row.blocks,
    };
  },

  async agent_details_by_project(
    project_id: string,
    agent_id: string,
    time_zone: string
  ): Promise<MetricsAgentDetails | null> {
    const rows = await db.execute(sql`
      with scoped as (${projectSpans(project_id, window_floor_nanos('30d'))}),
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
          coalesce(sum(${sql.raw(spanCost('s'))}), 0)::numeric(14, 6)::text as total_cost
        from scoped s
      ),
      agent_summary as (
        select
          count(distinct s.trace_id)::int as request_count,
          count(distinct ${sql.raw(spanAgentId('s'))})::int as replica_count,
          ${sql.raw(block_aggregates())}
        from agent_rows s
      ),
      series as (
        ${timeseries_sql({
          source: 'agent_rows s',
          interval: '30 days',
          unit: 'day',
          buckets: 30,
          time_zone: sql`${time_zone}`,
        })}
      ),
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
      time_window: '30d',
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

  // The parent walk reads every span the project owns, not the window: a span whose owned parent
  // started earlier is still a nested call, so only a span with no owned parent reaches depth 1.
  async flow_by_project(project_id: string, time_window: MetricsWindow): Promise<MetricsFlow> {
    const rows = await db.execute(sql`
      with recursive scoped as (${projectSpans(project_id, window_floor_nanos(time_window))}),
      all_spans as (${projectSpans(project_id, NO_FLOOR)}),
      ${sql.raw(AGENTS_CTE)},
      ancestry as (
        select s.trace_id, s.span_id, s.parent_span_id as ancestor_id, 0 as hops
        from scoped s
        union all
        select a.trace_id, a.span_id, p.parent_span_id, a.hops + 1
        from ancestry a
        join all_spans p on p.trace_id = a.trace_id and p.span_id = a.ancestor_id
        where a.hops < ${sql.raw(String(MAX_ANCESTRY_HOPS))}
      ),
      depths as (select trace_id, span_id, max(hops) as depth from ancestry group by 1, 2),
      placed as (
        select s.*, a.agent_id, a.replica_count, d.depth + 1 as depth
        from scoped s
        join agents a on a.name = s.name
        join depths d on d.trace_id = s.trace_id and d.span_id = s.span_id
      ),
      nodes as (
        select
          s.agent_id,
          (
            select inner_rows.name from placed inner_rows
            where inner_rows.agent_id = s.agent_id
            group by inner_rows.name
            order by count(*) desc, inner_rows.name
            limit 1
          ) as label,
          min(s.depth)::int as depth,
          max(s.replica_count)::int as replica_count,
          count(distinct s.trace_id)::int as request_count,
          ${sql.raw(block_aggregates())}
        from placed s
        group by s.agent_id
      ),
      edges as (
        select
          concat(${lit(AGENT_NODE_PREFIX)}, parent.agent_id) as source,
          concat(${lit(AGENT_NODE_PREFIX)}, child.agent_id) as target,
          count(*)::int as call_count,
          coalesce(sum(${sql.raw(spanCost('child'))}), 0)::numeric(14, 6)::text as cost
        from placed child
        join placed parent
          on parent.trace_id = child.trace_id and parent.span_id = child.parent_span_id
        where parent.agent_id <> child.agent_id
        group by 1, 2
        union all
        select
          ${lit(ENTRY_NODE_ID)} as source,
          concat(${lit(AGENT_NODE_PREFIX)}, s.agent_id) as target,
          count(*)::int as call_count,
          coalesce(sum(${sql.raw(spanCost('s'))}), 0)::numeric(14, 6)::text as cost
        from placed s
        where s.depth = 1
        group by s.agent_id
      ),
      entry as (
        select
          count(distinct s.trace_id)::int as request_count,
          count(*)::int as block_count
        from placed s
        where s.depth = 1
      )
      select
        coalesce((select sum(cost::numeric) from nodes), 0)::numeric(14, 6)::text as total_cost,
        coalesce((
          select json_agg(n.node order by n.depth, n.cost desc, n.label)
          from (
            select
              0 as depth,
              0::numeric as cost,
              ${lit(ENTRY_NODE_LABEL)} as label,
              json_build_object(
                'id', ${lit(ENTRY_NODE_ID)},
                'kind', 'entry',
                'agent_id', null,
                'label', ${lit(ENTRY_NODE_LABEL)},
                'depth', 0,
                'replica_count', 0,
                'request_count', e.request_count,
                'block_count', e.block_count,
                'cost', '0.000000',
                'llm_cost', '0.000000',
                'harness_cost', '0.000000',
                'recoverable_cost', '0.000000',
                'token_count', 0,
                'retry_rate', null,
                'failed_rate', null,
                'p95_latency_ms', null,
                'cache_hit_ratio', null
              ) as node
            from entry e
            where e.block_count > 0
            union all
            select
              g.depth,
              g.cost::numeric,
              g.label,
              json_build_object(
                'id', concat(${lit(AGENT_NODE_PREFIX)}, g.agent_id),
                'kind', 'agent',
                'agent_id', g.agent_id,
                'label', g.label,
                'depth', g.depth,
                'replica_count', g.replica_count,
                'request_count', g.request_count,
                'block_count', g.block_count,
                'cost', g.cost,
                'llm_cost', g.llm_cost,
                'harness_cost', g.harness_cost,
                'recoverable_cost', g.recoverable_cost,
                'token_count', g.token_count,
                'retry_rate', g.retry_rate,
                'failed_rate', g.failed_rate,
                'p95_latency_ms', g.p95_latency_ms,
                'cache_hit_ratio', g.cache_hit_ratio
              ) as node
            from nodes g
          ) n
        ), '[]'::json) as nodes,
        coalesce((
          select json_agg(json_build_object(
            'id', concat(e.source, '->', e.target),
            'source', e.source,
            'target', e.target,
            'call_count', e.call_count,
            'cost', e.cost
          ) order by e.call_count desc, e.source, e.target)
          from edges e
        ), '[]'::json) as edges
    `);
    const row = (
      rows as unknown as [
        { total_cost: string; nodes: MetricsFlow['nodes']; edges: MetricsFlow['edges'] },
      ]
    )[0];
    return {
      project_id,
      time_window,
      total_cost: row.total_cost,
      nodes: row.nodes,
      edges: row.edges,
    };
  },
};
