import { sql } from 'drizzle-orm';
import type { RedisClient } from 'bun';
import type { SQL } from 'drizzle-orm';

import { db } from '@api/db/client';
import { otelLogs, otelMetrics } from '@api/db/schema';

import { scan_keys } from '../canyonos/canyonos.redis';
import { window_floor_nanos, WINDOW_INTERVALS } from '../metrics/metrics.scope';
import {
  isModelSpan,
  projectSpans,
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
import {
  AGENT_UP_METRIC,
  MACHINE_UTILIZATION_METRICS,
  QUEUE_LENGTH_METRIC,
  REPLICA_UP_SECONDS,
  REQUESTS_COMPLETED_METRIC,
  REQUESTS_STARTED_METRIC,
  RESOURCE_PROJECT_ATTRIBUTE,
  SATURATION_METRIC,
} from './monitoring.signals';
import type { MetricsWindow } from '../metrics/metrics.types';
import type {
  MonitoringErrorSummaryResponse,
  MonitoringGrid,
  MonitoringListQuery,
  MonitoringLlmCall,
  MonitoringLog,
  MonitoringLogSource,
  MonitoringLogsQuery,
  MonitoringQuery,
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

const GRID_UNITS: Record<MetricsWindow, 'hour' | 'day'> = {
  '1d': 'hour',
  '7d': 'day',
  '30d': 'day',
  '1q': 'day',
};

const BUCKET_COUNTS: Record<MetricsWindow, number> = {
  '1d': 24,
  '7d': 30,
  '30d': 30,
  '1q': 30,
};

const GRID_ZONE = 'UTC';

const LATENCY_QUANTILE = '0.95';

const ERROR_SEVERITY_NUMBER = 17;

const UNTYPED_ERROR = 'Untyped';

const UNKNOWN_AGENT = 'unknown';

const UNKNOWN_HOST = 'unknown';

const GROUP_LIMIT = 10;

const AGENT_INSTANCE_PATTERN = 'agent_instance:*';

const REPLICA_ID = `nullif(m.resource_attributes ->> 'service.instance.id', '')`;

const latest_of = (metric: string): SQL =>
  sql`max(l.value) filter (where l.metric_name = ${metric})`;

const METRIC_NAME_LIST = sql`(${sql.join(
  Object.values(MACHINE_UTILIZATION_METRICS).map((metric) => sql`${metric}`),
  sql`, `
)})`;

const RESOURCE_ORDER_SQL = `case resource
  when 'cpu' then 1 when 'memory' then 2 when 'disk' then 3 when 'gpu' then 4 else 5 end`;

const resource_case = (alias: string): string =>
  `case ${alias}.metric_name
${Object.entries(MACHINE_UTILIZATION_METRICS)
  .map(([resource, metric]) => `    when '${metric}' then '${resource}'`)
  .join('\n')}
  end`;

const bucket_index = (time_expr: string, buckets: string): string => `
  least(
    floor(
      extract(epoch from ((${time_expr} at time zone '${GRID_ZONE}') - g.start_local))::float8
        / g.bucket_seconds
    )::int + 1,
    ${buckets}::int
  )`;

const metricTime = (alias: string): string => `to_timestamp(${alias}.time_unix_nano / 1e9)`;

const traceStart = (alias: string): string =>
  `to_timestamp(min(${alias}.start_time_unix_nano) / 1e9)`;

const traceDurationMs = (alias: string): string =>
  `((max(${alias}.end_time_unix_nano) - min(${alias}.start_time_unix_nano)) / 1e6)`;

// The stats read the same per-bucket value the chart draws, over the buckets that have one.
const value_series = (value: string): string => `json_build_object(
  'values', json_agg(${value} order by b),
  'average', avg(${value})::float8,
  'peak', max(${value})::float8,
  'latest', (array_agg(${value} order by b desc) filter (where ${value} is not null))[1]::float8,
  'samples', count(${value})::int
)`;

const series_sql = (project_id: string, time_window: MetricsWindow): SQL => {
  const buckets = String(BUCKET_COUNTS[time_window]);
  const interval = WINDOW_INTERVALS[time_window];
  const unit = GRID_UNITS[time_window];

  return sql`
    with scoped as (${projectSpans(project_id, window_floor_nanos(time_window))}),
    traces as (
      select
        s.trace_id,
        ${sql.raw(traceStart('s'))} as started_at,
        ${sql.raw(traceDurationMs('s'))} as duration_ms,
        bool_or(${sql.raw(spanFailed('s'))}) as failed
      from scoped s
      group by s.trace_id
    ),
    grid as (
      select
        e.end_local - interval '${sql.raw(interval)}' as start_local,
        e.end_local,
        extract(epoch from interval '${sql.raw(interval)}')::float8 / ${sql.raw(buckets)}::int
          as bucket_seconds
      from (
        select date_trunc('${sql.raw(unit)}', now() at time zone ${GRID_ZONE})
          + interval '1 ${sql.raw(unit)}' as end_local
      ) e
    ),
    traces_bucket as (
      select
        ${sql.raw(bucket_index('t.started_at', buckets))} as bucket,
        count(*)::int as traffic,
        count(*) filter (where t.failed)::int as errors,
        percentile_cont(${sql.raw(LATENCY_QUANTILE)}) within group (
          order by t.duration_ms
        )::float8 as latency
      from traces t cross join grid g
      where t.started_at >= g.start_local at time zone ${GRID_ZONE}
      group by 1
    ),
    metrics_bucket as (
      select
        ${sql.raw(bucket_index(metricTime('m'), buckets))} as bucket,
        avg(m.value)::float8 as saturation
      from ${otelMetrics} m cross join grid g
      where m.metric_name = ${SATURATION_METRIC}
        and (m.resource_attributes ->> ${RESOURCE_PROJECT_ATTRIBUTE}) = ${project_id}
        and ${sql.raw(metricTime('m'))} >= g.start_local at time zone ${GRID_ZONE}
      group by 1
    )
    select
      g.bucket_seconds,
      json_agg(
        (g.start_local + make_interval(secs => (b - 1) * g.bucket_seconds)) at time zone ${GRID_ZONE}
        order by b
      ) as bucket_start_ats,
      ${sql.raw(value_series('coalesce(s.traffic, 0)'))} as traffic,
      ${sql.raw(value_series('coalesce(s.errors, 0)'))} as errors,
      ${sql.raw(value_series('s.latency'))} as latency,
      ${sql.raw(value_series('m.saturation'))} as saturation
    from grid g
    cross join generate_series(1, ${sql.raw(buckets)}::int) b
    left join traces_bucket s on s.bucket = b
    left join metrics_bucket m on m.bucket = b
    group by g.bucket_seconds, g.start_local, g.end_local
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

const log_scope = (project_id: string, floor_nanos: string): SQL => sql`
  l.time_unix_nano >= ${sql.raw(floor_nanos)}
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
      avg(value)::float8 as average,
      max(value)::float8 as peak,
      (array_agg(value order by at_nanos desc))[1]::float8 as latest,
      count(*)::int as samples
    from ${prefix}_samples group by key, resource
  ),
  ${prefix}_bucket as (
    select key, resource, bucket, avg(value)::float8 as value
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

export const monitoring_repo = {
  async series(project_id: string, { time_window }: MonitoringQuery): Promise<SeriesRow> {
    const rows = await db.execute(series_sql(project_id, time_window));
    return (rows as unknown as [SeriesRow])[0];
  },

  async logs(
    project_id: string,
    { time_window, limit, errors_only, agent, replica }: MonitoringLogsQuery
  ): Promise<MonitoringLog[]> {
    const floor_nanos = window_floor_nanos(time_window);
    const severity_filter = errors_only ? sql`and ${ERROR_SEVERITY}` : sql``;
    const agent_filter = agent === undefined ? sql`` : sql`and ${LOG_AGENT} = ${agent}`;
    const replica_filter = replica === undefined ? sql`` : sql`and ${LOG_REPLICA} = ${replica}`;
    const rows = await db.execute(sql`
      with scoped as (${projectSpans(project_id, floor_nanos)}),
      project_traces as (select distinct s.trace_id from scoped s)
      select
        to_char(${sql.raw(metricTime('l'))} at time zone ${GRID_ZONE}, 'YYYY-MM-DD"T"HH24:MI:SSZ')
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
      where ${log_scope(project_id, floor_nanos)}
        ${severity_filter}
        ${agent_filter}
        ${replica_filter}
      order by l.time_unix_nano desc
      limit ${limit}
    `);
    return rows as unknown as MonitoringLog[];
  },

  async llm_calls(
    project_id: string,
    { time_window, limit }: MonitoringListQuery
  ): Promise<MonitoringLlmCall[]> {
    const floor_nanos = window_floor_nanos(time_window);
    const rows = await db.execute(sql`
      with scoped as (${projectSpans(project_id, floor_nanos)})
      select
        to_char(${sql.raw(spanStart('s'))} at time zone ${GRID_ZONE},
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
      limit ${limit}
    `);
    return rows as unknown as MonitoringLlmCall[];
  },

  async traces(
    project_id: string,
    { time_window, limit }: MonitoringListQuery
  ): Promise<MonitoringTrace[]> {
    const floor_nanos = window_floor_nanos(time_window);
    const agent = `nullif(${spanAgentId('s')}, '')`;
    const rows = await db.execute(sql`
      with scoped as (${projectSpans(project_id, floor_nanos)}),
      recent as (
        select s.trace_id, min(s.start_time_unix_nano) as start_nanos
        from scoped s
        group by s.trace_id
        order by start_nanos desc
        limit ${limit}
      )
      select
        to_char(to_timestamp(r.start_nanos / 1e9) at time zone ${GRID_ZONE},
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

  async log_sources(
    project_id: string,
    { time_window }: MonitoringQuery
  ): Promise<MonitoringLogSource[]> {
    const floor_nanos = window_floor_nanos(time_window);
    const rows = await db.execute(sql`
      with scoped as (${projectSpans(project_id, floor_nanos)}),
      project_traces as (select distinct s.trace_id from scoped s),
      sources as (
        select distinct ${LOG_AGENT} as agent, ${LOG_REPLICA} as replica
        from ${otelLogs} l
        where ${log_scope(project_id, floor_nanos)}
      )
      select agent, json_agg(replica order by replica) as replicas
      from sources group by agent order by agent
    `);
    return rows as unknown as MonitoringLogSource[];
  },

  async resource_utilization(
    project_id: string,
    { time_window }: MonitoringQuery
  ): Promise<ResourceUtilizationRow> {
    const floor_nanos = window_floor_nanos(time_window);
    const buckets = String(BUCKET_COUNTS[time_window]);
    const interval = WINDOW_INTERVALS[time_window];
    const unit = GRID_UNITS[time_window];

    const rows = await db.execute(sql`
      with scoped as (${projectSpans(project_id, floor_nanos)}),
      grid as (
        select
          e.end_local - interval '${sql.raw(interval)}' as start_local,
          e.end_local,
          extract(epoch from interval '${sql.raw(interval)}')::float8 / ${sql.raw(buckets)}::int
            as bucket_seconds
        from (
          select date_trunc('${sql.raw(unit)}', now() at time zone ${GRID_ZONE})
            + interval '1 ${sql.raw(unit)}' as end_local
        ) e
      ),
      slots as (select b from generate_series(1, ${sql.raw(buckets)}::int) b),
      machine_samples as (
        select
          coalesce(nullif(m.resource_attributes ->> 'host.name', ''), m.service_name, ${UNKNOWN_HOST})
            as key,
          ${sql.raw(resource_case('m'))} as resource,
          m.value,
          m.time_unix_nano as at_nanos,
          ${sql.raw(bucket_index(metricTime('m'), buckets))} as bucket
        from ${otelMetrics} m cross join grid g
        where m.metric_name in ${METRIC_NAME_LIST}
          and (m.resource_attributes ->> ${RESOURCE_PROJECT_ATTRIBUTE}) = ${project_id}
          and ${sql.raw(metricTime('m'))} >= g.start_local at time zone ${GRID_ZONE}
      ),
      agent_samples as (
        select
          coalesce(nullif(${sql.raw(spanAgentName('s'))}, ''), ${UNKNOWN_AGENT}) as key,
          'cpu' as resource,
          ${sql.raw(spanCpuPercent('s'))} as value,
          s.start_time_unix_nano as at_nanos,
          ${sql.raw(bucket_index(spanStart('s'), buckets))} as bucket
        from scoped s cross join grid g
        where ${sql.raw(spanCpuPercent('s'))} is not null
          and ${sql.raw(spanStart('s'))} >= g.start_local at time zone ${GRID_ZONE}
      ),
      ${entity_rollup('machine')},
      ${entity_rollup('agent')}
      select
        g.bucket_seconds,
        json_agg(
          (g.start_local + make_interval(secs => (s.b - 1) * g.bucket_seconds))
            at time zone ${GRID_ZONE}
          order by s.b
        ) as bucket_start_ats,
        (select coalesce(
            json_agg(json_build_object('key', m.key, 'series', m.series)
              order by m.cpu_average desc nulls last, m.key), '[]'::json)
          from machine_rows m) as machines,
        (select coalesce(
            json_agg(json_build_object('key', a.key, 'series', a.series)
              order by a.cpu_average desc nulls last, a.key), '[]'::json)
          from agent_rows a) as agents
      from grid g cross join slots s
      group by g.bucket_seconds
    `);
    return (rows as unknown as [ResourceUtilizationRow])[0];
  },

  async replicas(project_id: string): Promise<MonitoringReplica[]> {
    const rows = await db.execute(sql`
      select l.agent, l.replica,
        ${latest_of(QUEUE_LENGTH_METRIC)}::int as queue_length,
        (${latest_of(REQUESTS_STARTED_METRIC)} - ${latest_of(REQUESTS_COMPLETED_METRIC)})::int
          as active_requests
      from (
        select distinct on (replica, m.metric_name)
          m.service_name as agent,
          ${sql.raw(REPLICA_ID)} as replica,
          m.metric_name,
          m.value
        from ${otelMetrics} m
        where m.metric_name in (${AGENT_UP_METRIC}, ${QUEUE_LENGTH_METRIC},
            ${REQUESTS_STARTED_METRIC}, ${REQUESTS_COMPLETED_METRIC})
          and (m.resource_attributes ->> ${RESOURCE_PROJECT_ATTRIBUTE}) = ${project_id}
          and ${sql.raw(REPLICA_ID)} is not null
          and ${sql.raw(metricTime('m'))} >= now() - make_interval(secs => ${REPLICA_UP_SECONDS})
        order by replica, m.metric_name, m.time_unix_nano desc
      ) l
      group by l.agent, l.replica
      having ${latest_of(AGENT_UP_METRIC)} = 1
      order by l.agent, l.replica
    `);
    return rows as unknown as MonitoringReplica[];
  },

  async agent_instances(redis: RedisClient): Promise<Record<string, string>[]> {
    const keys = await scan_keys(redis, AGENT_INSTANCE_PATTERN);
    return Promise.all(keys.sort().map((key) => redis.hgetall(key)));
  },

  async error_summary(
    project_id: string,
    { time_window }: MonitoringQuery
  ): Promise<ErrorSummaryRow> {
    const floor_nanos = window_floor_nanos(time_window);
    const rows = await db.execute(sql`
      with scoped as (${projectSpans(project_id, floor_nanos)}),
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
        where ${log_scope(project_id, floor_nanos)}
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
