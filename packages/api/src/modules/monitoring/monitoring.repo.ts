// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { RedisClient } from 'bun';
import type { SQL } from 'drizzle-orm';

import { db } from '@api/db/client';
import { otelLogs, otelMetricRollups, otelMetrics } from '@api/db/schema';
import { timeGrid, withinRange } from '@core/time-range';
import type { GridQuery, TimeRange } from '@core/time-range';

import {
  isModelSpan,
  projectRequestSpans,
  projectSpans,
  requestStart,
  spanAgentId,
  spanAgentName,
  spanCacheHitRatio,
  spanCost,
  spanCpuPercent,
  spanDurationMs,
  spanFailed,
  spanInputTokens,
  spanModel,
  spanOutputTokens,
  spanStart,
} from '../metrics/metrics.sql';
import { bucket_start_of, ROLLUP_SECONDS } from '../telemetry/telemetry.rollup';
import {
  AGENT_DRAINING_METRIC,
  AGENT_UP_METRIC,
  MACHINE_UTILIZATION_METRICS,
  QUEUE_LENGTH_METRIC,
  REPLICA_UP_SECONDS,
  REQUESTS_COMPLETED_METRIC,
  REQUESTS_STARTED_METRIC,
  RESOURCE_PROJECT_ATTRIBUTE,
  SATURATION_METRIC,
} from './monitoring.signals';
import type {
  MonitoringErrorSummaryResponse,
  MonitoringGrid,
  MonitoringListQuery,
  MonitoringLlmCall,
  MonitoringLog,
  MonitoringLogSource,
  MonitoringLogsQuery,
  MonitoringReplica,
  MonitoringResourceUtilizationResponse,
  MonitoringScope,
  MonitoringSignal,
  MonitoringTrace,
  MonitoringValueSeries,
} from './monitoring.types';

type SeriesRow = MonitoringGrid & Record<MonitoringSignal, MonitoringValueSeries>;

type ResourceUtilizationRow = Omit<MonitoringResourceUtilizationResponse, keyof MonitoringScope>;

type ErrorSummaryRow = Omit<MonitoringErrorSummaryResponse, keyof MonitoringScope>;

const LATENCY_QUANTILE = '0.95';

const ERROR_SEVERITY_NUMBER = 17;

const UNTYPED_ERROR = 'Untyped';

const UNKNOWN_AGENT = 'unknown';

const UNKNOWN_HOST = 'unknown';

const GROUP_LIMIT = 10;

export const ENDPOINT_KEY = 'endpoint:address';

const JsonArgumentNames = z
  .string()
  .transform((raw, ctx) => {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'arguments is not JSON' });
      return z.NEVER;
    }
  })
  .pipe(z.array(z.string()));

/** The endpoint:address hash as the GlobalController writes it while the endpoint runs. */
const EndpointAddressSchema = z.object({
  public_host: z.string().min(1),
  api_port: z.string().regex(/^\d+$/),
  agent: z.string().min(1),
  method: z.string().min(1),
  arguments: JsonArgumentNames,
  url: z.string().url(),
});

export type EndpointAddress = z.infer<typeof EndpointAddressSchema>;

const REPLICA_ID = `nullif(m.resource_attributes ->> 'service.instance.id', '')`;

const latest_of = (metric: string): SQL =>
  sql`max(l.value) filter (where l.metric_name = ${metric})`;

const RESOURCE_ORDER_SQL = `case resource
  when 'cpu' then 1 when 'memory' then 2 when 'disk' then 3 when 'gpu' then 4 else 5 end`;

const resource_case = (alias: string): string =>
  `case ${alias}.metric_name
${Object.entries(MACHINE_UTILIZATION_METRICS)
  .map(([resource, metric]) => `    when '${metric}' then '${resource}'`)
  .join('\n')}
  end`;

const metricTime = (alias: string): string => `to_timestamp(${alias}.time_unix_nano / 1e9)`;

const unix_nanos = (at: string): bigint => BigInt(Date.parse(at)) * 1_000_000n;

type Grid = ReturnType<typeof timeGrid>;

/**
 * The project's readings of `metric_names` in the range as weighted samples
 * (`key, resource, sum, count, max, last_value, last_time, bucket`), so one aggregate serves raw
 * ticks and rollups alike. Every grid step of five minutes or more holds whole five-minute buckets,
 * so those grids read the rollups, which outlive the raw ticks; finer grids need the raw ticks.
 */
const metric_samples = (
  project_id: string,
  query: GridQuery,
  grid: Grid,
  metric_names: readonly string[]
): SQL => {
  const identity = sql`
    coalesce(nullif(m.resource_attributes ->> 'host.name', ''), m.service_name, ${UNKNOWN_HOST})
      as key,
    ${sql.raw(resource_case('m'))} as resource`;
  // The key is inlined so the rollups' expression index matches even under a generic plan.
  const scope = sql`m.metric_name in (${sql.join(
    metric_names.map((metric) => sql`${metric}`),
    sql`, `
  )})
    and (m.resource_attributes ->> '${sql.raw(RESOURCE_PROJECT_ATTRIBUTE)}') = ${project_id}`;
  if (grid.bucket_seconds < ROLLUP_SECONDS) {
    return sql`
      select ${identity},
        m.value as sum, 1 as count, m.value as max, m.value as last_value,
        m.time_unix_nano as last_time,
        ${grid.index(metricTime('m'))} as bucket
      from ${otelMetrics} m
      where ${scope}
        and ${withinRange('m.time_unix_nano', query)}`;
  }
  // The bucket holding `from` counts whole: the first grid bucket already opens before `from`.
  return sql`
    select ${identity},
      m.sum, m.count, m.max, m.last_value,
      m.last_time_unix_nano as last_time,
      ${grid.index('to_timestamp(m.bucket_start_unix_nano / 1e9)')} as bucket
    from ${otelMetricRollups} m
    where ${scope}
      and m.bucket_start_unix_nano >= ${bucket_start_of(unix_nanos(query.from))}
      and m.bucket_start_unix_nano < ${unix_nanos(query.to)}`;
};

const weighted_average = 'sum(sum) / sum(count)';

// The stats read the same per-bucket value the chart draws, over the buckets that have one.
const value_series = (value: string): string => `json_build_object(
  'values', json_agg(${value} order by sl.b),
  'average', avg(${value})::float8,
  'peak', max(${value})::float8,
  'latest', (array_agg(${value} order by sl.b desc) filter (where ${value} is not null))[1]::float8,
  'samples', count(${value})::int
)`;

export const series_sql = (project_id: string, query: GridQuery): SQL => {
  const grid = timeGrid(query);

  return sql`
    with scoped as (${projectRequestSpans(project_id, query)}),
    traces as (
      select
        s.trace_id,
        ${sql.raw(requestStart('s'))} as started_at,
        ((max(s.end_time_unix_nano) - s.request_start_unix_nano) / 1e6) as duration_ms,
        bool_or(${sql.raw(spanFailed('s'))}) as failed
      from scoped s
      group by s.trace_id, s.request_start_unix_nano
    ),
    slots as (${grid.slots}),
    traces_bucket as (
      select
        ${grid.index('t.started_at')} as bucket,
        count(*)::int as traffic,
        count(*) filter (where t.failed)::int as errors,
        percentile_cont(${sql.raw(LATENCY_QUANTILE)}) within group (
          order by t.duration_ms
        )::float8 as latency
      from traces t
      group by 1
    ),
    metric_samples as (${metric_samples(project_id, query, grid, [SATURATION_METRIC])}),
    metrics_bucket as (
      select bucket, (${sql.raw(weighted_average)})::float8 as saturation
      from metric_samples group by bucket
    )
    select
      ${grid.bucket_seconds}::float8 as bucket_seconds,
      json_agg(sl.bucket_start order by sl.b) as bucket_start_ats,
      ${sql.raw(value_series('coalesce(s.traffic, 0)'))} as traffic,
      ${sql.raw(value_series('coalesce(s.errors, 0)'))} as errors,
      ${sql.raw(value_series('s.latency'))} as latency,
      ${sql.raw(value_series('m.saturation'))} as saturation
    from slots sl
    left join traces_bucket s on s.bucket = sl.b
    left join metrics_bucket m on m.bucket = sl.b
  `;
};

const ERROR_SEVERITY = sql`(l.severity_number >= ${ERROR_SEVERITY_NUMBER}
  or l.severity_text in ('ERROR', 'FATAL'))`;

const LOG_AGENT = sql.raw(`coalesce(
  nullif(l.attributes ->> 'canyonos.agent.name', ''),
  nullif(l.attributes ->> 'canyonos.agent.id', ''),
  l.service_name,
  'unknown'
)`);

const LOG_REPLICA = sql.raw(`coalesce(
  nullif(l.attributes ->> 'canyonos.agent.id', ''),
  l.service_name,
  'unknown'
)`);

const log_scope = (project_id: string, range: TimeRange): SQL => sql`
  ${withinRange('l.time_unix_nano', range)}
  and (
    (l.resource_attributes ->> ${RESOURCE_PROJECT_ATTRIBUTE}) = ${project_id}
    or l.trace_id in (select trace_id from project_traces)
  )`;

const entity_rollup = (prefix: 'machine' | 'agent'): SQL =>
  sql.raw(`
  ${prefix}_stats as (
    select
      key,
      resource,
      (${weighted_average})::float8 as average,
      max(max)::float8 as peak,
      (array_agg(last_value order by last_time desc))[1]::float8 as latest,
      sum(count)::int as samples
    from ${prefix}_samples group by key, resource
  ),
  ${prefix}_bucket as (
    select key, resource, bucket, (${weighted_average})::float8 as value
    from ${prefix}_samples group by key, resource, bucket
  ),
  ${prefix}_series as (
    select
      st.key, st.resource, st.average, st.peak, st.latest, st.samples,
      (
        select json_agg(bk.value order by sl.b)
        from slots sl
        left join ${prefix}_bucket bk
          on bk.key = st.key and bk.resource = st.resource and bk.bucket = sl.b
      ) as values
    from ${prefix}_stats st
  ),
  ${prefix}_rows as (
    select
      key,
      json_agg(
        json_build_object(
          'resource', resource, 'average', average, 'peak', peak,
          'latest', latest, 'samples', samples, 'values', values
        )
        order by ${RESOURCE_ORDER_SQL}
      ) as series,
      max(average) filter (where resource = 'cpu') as cpu_average
    from ${prefix}_series group by key
  )`);

export const resource_utilization_sql = (project_id: string, range: GridQuery): SQL => {
  const grid = timeGrid(range);
  return sql`
    with scoped as (${projectRequestSpans(project_id, range)}),
    slots as (${grid.slots}),
    machine_samples as (${metric_samples(
      project_id,
      range,
      grid,
      Object.values(MACHINE_UTILIZATION_METRICS)
    )}),
    agent_samples as (
      select
        coalesce(nullif(${sql.raw(spanAgentName('s'))}, ''), ${UNKNOWN_AGENT}) as key,
        'cpu' as resource,
        c.cpu as sum, 1 as count, c.cpu as max, c.cpu as last_value,
        s.start_time_unix_nano as last_time,
        ${grid.index(requestStart('s'))} as bucket
      from scoped s
      cross join lateral (select ${sql.raw(spanCpuPercent('s'))} as cpu) c
      where c.cpu is not null
    ),
    ${entity_rollup('machine')},
    ${entity_rollup('agent')}
    select
      ${grid.bucket_seconds}::float8 as bucket_seconds,
      (select json_agg(sl.bucket_start order by sl.b) from slots sl) as bucket_start_ats,
      (select coalesce(
          json_agg(json_build_object('key', m.key, 'series', m.series)
            order by m.cpu_average desc nulls last, m.key), '[]'::json)
        from machine_rows m) as machines,
      (select coalesce(
          json_agg(json_build_object('key', a.key, 'series', a.series)
            order by a.cpu_average desc nulls last, a.key), '[]'::json)
        from agent_rows a) as agents
  `;
};

export const replicas_sql = (project_id: string): SQL => sql`
  select l.agent, l.replica,
    ${latest_of(QUEUE_LENGTH_METRIC)}::int as queue_length,
    (${latest_of(REQUESTS_STARTED_METRIC)} - ${latest_of(REQUESTS_COMPLETED_METRIC)})::int
      as active_requests,
    coalesce(${latest_of(AGENT_DRAINING_METRIC)}, 0) = 1 as draining
  from (
    select distinct on (replica, m.metric_name)
      m.service_name as agent,
      ${sql.raw(REPLICA_ID)} as replica,
      m.metric_name,
      m.value
    from ${otelMetrics} m
    where m.metric_name in (${AGENT_UP_METRIC}, ${QUEUE_LENGTH_METRIC},
        ${REQUESTS_STARTED_METRIC}, ${REQUESTS_COMPLETED_METRIC}, ${AGENT_DRAINING_METRIC})
      and (m.resource_attributes ->> ${RESOURCE_PROJECT_ATTRIBUTE}) = ${project_id}
      and ${sql.raw(REPLICA_ID)} is not null
      and m.time_unix_nano >= (extract(epoch from now()) * 1e9)::bigint
        - ${REPLICA_UP_SECONDS}::bigint * 1000000000
    order by replica, m.metric_name, m.time_unix_nano desc
  ) l
  group by l.agent, l.replica
  having ${latest_of(AGENT_UP_METRIC)} = 1
  order by l.agent, l.replica
`;

export const monitoring_repo = {
  async series(project_id: string, query: GridQuery): Promise<SeriesRow> {
    const rows = await db.execute(series_sql(project_id, query));
    return (rows as unknown as [SeriesRow])[0];
  },

  async logs(project_id: string, query: MonitoringLogsQuery): Promise<MonitoringLog[]> {
    const { limit, errors_only, agent, replica } = query;
    const range = query;
    const severity_filter = errors_only ? sql`and ${ERROR_SEVERITY}` : sql``;
    const agent_filter = agent === undefined ? sql`` : sql`and ${LOG_AGENT} = ${agent}`;
    const replica_filter = replica === undefined ? sql`` : sql`and ${LOG_REPLICA} = ${replica}`;
    const rows = await db.execute(sql`
      with scoped as (${projectSpans(project_id, range)}),
      project_traces as (select distinct s.trace_id from scoped s)
      select
        to_char(${sql.raw(metricTime('l'))} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SSZ')
          as at,
        l.severity_text as severity,
        l.severity_number,
        (l.attributes ->> 'canyonos.agent.name') as agent,
        coalesce(l.attributes ->> 'canyonos.agent.id', l.service_name) as replica,
        l.body,
        l.trace_id,
        l.span_id,
        l.attributes - 'canyonos.agent.id' - 'canyonos.agent.name' as attributes
      from ${otelLogs} l
      where ${log_scope(project_id, range)}
        ${severity_filter}
        ${agent_filter}
        ${replica_filter}
      order by l.time_unix_nano desc
      limit ${limit}
    `);
    return rows as unknown as MonitoringLog[];
  },

  async llm_calls(project_id: string, query: MonitoringListQuery): Promise<MonitoringLlmCall[]> {
    const rows = await db.execute(sql`
      with scoped as (${projectRequestSpans(project_id, query)})
      select
        to_char(${sql.raw(spanStart('s'))} at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SSZ') as at,
        s.name,
        ${sql.raw(spanModel('s'))} as model,
        nullif(${sql.raw(spanAgentId('s'))}, '') as agent,
        ${sql.raw(spanDurationMs('s'))}::float8 as duration_ms,
        ${sql.raw(spanInputTokens('s'))}::int as input_tokens,
        ${sql.raw(spanOutputTokens('s'))}::int as output_tokens,
        ${sql.raw(spanCacheHitRatio('s'))}::float8 as cache_hit_ratio,
        ${sql.raw(spanCost('s'))}::float8 as cost,
        ${sql.raw(spanFailed('s'))} as failed,
        s.status_message,
        s.trace_id,
        s.span_id,
        s.input,
        s.output,
        s.attributes
      from scoped s
      where ${sql.raw(isModelSpan('s'))}
      order by s.start_time_unix_nano desc
      limit ${query.limit}
    `);
    return rows as unknown as MonitoringLlmCall[];
  },

  async traces(project_id: string, query: MonitoringListQuery): Promise<MonitoringTrace[]> {
    const agent = `nullif(${spanAgentId('s')}, '')`;
    const rows = await db.execute(sql`
      with scoped as (${projectRequestSpans(project_id, query)}),
      recent as (
        select distinct s.trace_id, s.request_start_unix_nano as start_nanos
        from scoped s
        order by start_nanos desc
        limit ${query.limit}
      )
      select
        to_char(to_timestamp(r.start_nanos / 1e9) at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SSZ') as at,
        r.trace_id,
        (array_agg(s.name order by coalesce(s.parent_span_id, '') <> '', s.start_time_unix_nano))[1]
          as name,
        to_json(coalesce(
          array_agg(distinct ${sql.raw(agent)}) filter (where ${sql.raw(agent)} is not null),
          '{}'::text[]
        )) as agents,
        count(*)::int as span_count,
        ((max(s.end_time_unix_nano) - r.start_nanos) / 1e6)::float8 as duration_ms,
        bool_or(${sql.raw(spanFailed('s'))}) as failed,
        sum(${sql.raw(spanCost('s'))})::float8 as total_cost,
        json_agg(
          json_build_object(
            'span_id', s.span_id,
            'parent_span_id', nullif(s.parent_span_id, ''),
            'name', s.name,
            'agent', ${sql.raw(agent)},
            'offset_ms', ((s.start_time_unix_nano - r.start_nanos) / 1e6)::float8,
            'duration_ms', ${sql.raw(spanDurationMs('s'))}::float8,
            'failed', ${sql.raw(spanFailed('s'))},
            'status_message', s.status_message,
            'llm', case when ${sql.raw(isModelSpan('s'))} then json_build_object(
              'model', ${sql.raw(spanModel('s'))},
              'input_tokens', ${sql.raw(spanInputTokens('s'))}::int,
              'output_tokens', ${sql.raw(spanOutputTokens('s'))}::int,
              'cost', ${sql.raw(spanCost('s'))}::float8,
              'input', s.input,
              'output', s.output
            ) end
          )
          order by s.start_time_unix_nano
        ) as spans
      from recent r
      join scoped s on s.trace_id = r.trace_id
      group by r.trace_id, r.start_nanos
      order by r.start_nanos desc
    `);
    return rows as unknown as MonitoringTrace[];
  },

  async log_sources(project_id: string, range: TimeRange): Promise<MonitoringLogSource[]> {
    const rows = await db.execute(sql`
      with scoped as (${projectSpans(project_id, range)}),
      project_traces as (select distinct s.trace_id from scoped s),
      sources as (
        select distinct ${LOG_AGENT} as agent, ${LOG_REPLICA} as replica
        from ${otelLogs} l
        where ${log_scope(project_id, range)}
      )
      select agent, json_agg(replica order by replica) as replicas
      from sources group by agent order by agent
    `);
    return rows as unknown as MonitoringLogSource[];
  },

  async resource_utilization(
    project_id: string,
    range: GridQuery
  ): Promise<ResourceUtilizationRow> {
    const rows = await db.execute(resource_utilization_sql(project_id, range));
    return (rows as unknown as [ResourceUtilizationRow])[0];
  },

  async replicas(project_id: string): Promise<MonitoringReplica[]> {
    const rows = await db.execute(replicas_sql(project_id));
    return rows as unknown as MonitoringReplica[];
  },

  /** The recorded address, or null when none is recorded or the record is incomplete. */
  async endpoint(redis: RedisClient): Promise<EndpointAddress | null> {
    const result = EndpointAddressSchema.safeParse(await redis.hgetall(ENDPOINT_KEY));
    return result.success ? result.data : null;
  },

  async error_summary(project_id: string, range: TimeRange): Promise<ErrorSummaryRow> {
    const rows = await db.execute(sql`
      with scoped as (${projectSpans(project_id, range)}),
      project_traces as (select distinct s.trace_id from scoped s),
      errors as (
        select
          coalesce(nullif(l.attributes ->> 'exception.type', ''), ${UNTYPED_ERROR}) as error_type,
          coalesce(
            nullif(l.attributes ->> 'canyonos.agent.name', ''),
            nullif(l.attributes ->> 'canyonos.agent.id', ''),
            l.service_name,
            ${UNKNOWN_AGENT}
          ) as agent
        from ${otelLogs} l
        where ${log_scope(project_id, range)}
          and ${ERROR_SEVERITY}
      ),
      by_type as (
        select error_type as key, count(*)::int as count from errors group by 1
        order by count desc, key limit ${GROUP_LIMIT}
      ),
      by_agent as (
        select agent as key, count(*)::int as count from errors group by 1
        order by count desc, key limit ${GROUP_LIMIT}
      )
      select
        (select count(*)::int from errors) as total,
        (select coalesce(json_agg(t order by t.count desc, t.key), '[]'::json) from by_type t)
          as by_type,
        (select coalesce(json_agg(a order by a.count desc, a.key), '[]'::json) from by_agent a)
          as by_agent
    `);
    return (rows as unknown as [ErrorSummaryRow])[0];
  },
};
