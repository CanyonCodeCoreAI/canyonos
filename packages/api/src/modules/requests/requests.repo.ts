import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';

import { db } from '@api/db/client';

import { OTEL_DISTRIBUTION_VALUES } from '../metrics/metrics.distribution';
import { NO_FLOOR, window_floor_nanos } from '../metrics/metrics.scope';
import {
  isModelSpan,
  projectSpans,
  spanCost,
  spanDurationMs,
  spanErrorCount,
  spanFailed,
  spanInput,
  spanInputTokens,
  spanModel,
  spanOutput,
  spanOutputTokens,
  spanServerCost,
  spanTokenCost,
  spanTotalTokens,
} from '../metrics/metrics.sql';
import type { MetricsWindow } from '../metrics/metrics.types';
import type {
  RequestListItem,
  RequestMetricRange,
  RequestSort,
  RequestStatus,
  RequestTrace,
  RequestTraceBlock,
  SortDirection,
} from './requests.types';

/** What narrows the listing. The page and its `total` must be counted over the same set. */
export interface RequestFilters {
  readonly status?: RequestStatus;
  readonly time_window?: MetricsWindow;
  readonly range?: RequestMetricRange;
  readonly created_from?: string;
  readonly created_to?: string;
}

export interface RequestPage extends RequestFilters {
  readonly limit: number;
  readonly offset: number;
  readonly sort: RequestSort;
  readonly order: SortDirection;
}

const listing_floor = (time_window: MetricsWindow | undefined): string =>
  time_window === undefined ? NO_FLOOR : window_floor_nanos(time_window);

const REQUESTS_CTE = `requests as (
    select
      s.trace_id,
      min(s.start_time_unix_nano) as first_start,
      max(s.end_time_unix_nano) as last_end,
      count(*)::int as block_count,
      (count(*) filter (where ${spanFailed('s')}))::int as failed_block_count,
      coalesce(sum(${spanErrorCount('s')}), 0)::float8 as error_count,
      coalesce(sum(${spanTotalTokens('s')}), 0)::float8 as token_count,
      coalesce(sum(${spanTokenCost('s')}), 0)::numeric(14, 6) as llm_cost,
      coalesce(sum(${spanServerCost('s')}), 0)::numeric(14, 6) as harness_cost,
      coalesce(sum(${spanCost('s')}), 0)::numeric(14, 6) as total_cost
    from scoped s
    group by s.trace_id
  )`;

const REQUEST_STATUS = `(case when q.failed_block_count > 0 then 'failed' else 'completed' end)`;
const REQUEST_CREATED_AT = `to_timestamp(q.first_start / 1e9)`;
const REQUEST_FINISHED_AT = `to_timestamp(q.last_end / 1e9)`;
const REQUEST_DURATION_MS = `round((q.last_end - q.first_start) / 1e6)::float8`;

const REQUEST_COLUMNS = `q.trace_id as session_id,
      ${REQUEST_STATUS} as status,
      ${REQUEST_CREATED_AT}::text as created_at,
      ${REQUEST_CREATED_AT}::text as started_at,
      ${REQUEST_FINISHED_AT}::text as finished_at,
      ${REQUEST_DURATION_MS} as duration_ms,
      q.block_count,
      q.failed_block_count,
      q.error_count,
      q.token_count,
      q.llm_cost::text as llm_cost,
      q.harness_cost::text as harness_cost,
      q.total_cost::text as total_cost`;

const status_predicate = (status: RequestStatus | undefined): SQL => {
  if (status === undefined) return sql.empty();
  // `running` stays in the public union for the dashboard, but the store cannot hold one:
  // end_time_unix_nano is NOT NULL, so every span it returns has already finished.
  if (status === 'running') return sql` and false`;
  return sql` and ${sql.raw(REQUEST_STATUS)} = ${status}`;
};

// The final bucket includes its upper bound, matching metrics.distribution.ts.
const requests_in_metric_range = (project_id: string, range: RequestMetricRange): SQL => {
  const { value, having } = OTEL_DISTRIBUTION_VALUES[range.metric];
  return sql`
    select scored.trace_id
    from (
      select
        per_request.trace_id,
        per_request.value,
        max(per_request.value) over () as max_value
      from (
        select s.trace_id, ${sql.raw(value)} as value
        from (${projectSpans(project_id, window_floor_nanos(range.time_window))}) s
        group by s.trace_id
        ${sql.raw(having)}
      ) per_request
    ) scored
    where scored.value >= ${range.min}
      and case
        when ${range.max} >= scored.max_value then scored.value <= ${range.max}
        else scored.value < ${range.max}
      end
  `;
};

const metric_range_predicate = (project_id: string, range: RequestMetricRange | undefined): SQL =>
  range === undefined
    ? sql.empty()
    : sql` and q.trace_id in (${requests_in_metric_range(project_id, range)})`;

// Half-open [from, to), so two windows asked for back to back never share a request.
const created_range_predicate = (filters: RequestFilters): SQL => {
  const from =
    filters.created_from === undefined
      ? sql.empty()
      : sql` and ${sql.raw(REQUEST_CREATED_AT)} >= ${filters.created_from}::timestamptz`;
  const to =
    filters.created_to === undefined
      ? sql.empty()
      : sql` and ${sql.raw(REQUEST_CREATED_AT)} < ${filters.created_to}::timestamptz`;
  return sql`${from}${to}`;
};

const filter_predicates = (project_id: string, filters: RequestFilters): SQL =>
  sql`${metric_range_predicate(project_id, filters.range)}${status_predicate(filters.status)}${created_range_predicate(filters)}`;

const SORT_ORDER: Record<RequestSort, string> = {
  created_at: 'q.first_start',
  total_cost: 'q.total_cost',
  token_count: 'q.token_count',
  duration_ms: REQUEST_DURATION_MS,
  error_count: 'q.error_count',
};

const order_by = (sort: RequestSort, order: SortDirection): string => {
  const primary = `${SORT_ORDER[sort]} ${order}`;
  return sort === 'created_at'
    ? `${primary}, q.trace_id desc`
    : `${primary}, q.first_start desc, q.trace_id desc`;
};

/** Stored as text: what parses ships as the object it is, anything else as the string it was. */
function payload(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export const requests_repo = {
  async list_by_project(project_id: string, page: RequestPage): Promise<RequestListItem[]> {
    const rows = await db.execute(sql`
      with scoped as (${projectSpans(project_id, listing_floor(page.time_window))}),
      ${sql.raw(REQUESTS_CTE)}
      select ${sql.raw(REQUEST_COLUMNS)}
      from requests q
      where true${filter_predicates(project_id, page)}
      order by ${sql.raw(order_by(page.sort, page.order))}
      limit ${page.limit} offset ${page.offset}
    `);
    return rows as unknown as RequestListItem[];
  },

  async count_by_project(project_id: string, filters: RequestFilters): Promise<number> {
    const rows = await db.execute(sql`
      with scoped as (${projectSpans(project_id, listing_floor(filters.time_window))}),
      ${sql.raw(REQUESTS_CTE)}
      select count(*)::int as total
      from requests q
      where true${filter_predicates(project_id, filters)}
    `);
    return (rows as unknown as [{ total: number }])[0].total;
  },

  /** Never window-scoped: a request straddling a window edge must still read completely. */
  async trace_by_project(project_id: string, session_id: string): Promise<RequestTrace | null> {
    const rows = await db.execute(sql`
      with scoped as (
        select s.* from (${projectSpans(project_id, NO_FLOOR)}) s where s.trace_id = ${session_id}
      ),
      ${sql.raw(REQUESTS_CTE)},
      -- Billed requests only: one that never priced itself contributes a $0 that drags the
      -- reference below every request a reader could compare against.
      project_requests as (
        select
          coalesce(sum(${sql.raw(spanTotalTokens('s'))}), 0)::float8 as token_count,
          sum(${sql.raw(spanCost('s'))}) as total_cost,
          coalesce(sum(${sql.raw(spanServerCost('s'))}), 0) as harness_cost
        from (${projectSpans(project_id, window_floor_nanos('30d'))}) s
        group by s.trace_id
        having sum(${sql.raw(spanCost('s'))}) > 0
      ),
      medians as (
        select
          percentile_cont(0.5) within group (order by m.token_count)::float8 as median_token_count,
          percentile_cont(0.5) within group (order by m.total_cost)
            ::numeric(14, 6)::text as median_cost,
          percentile_cont(0.5) within group (order by m.harness_cost)
            ::numeric(14, 6)::text as median_harness_cost
        from project_requests m
      ),
      block_rows as (
        select
          s.span_id as future_id,
          s.name as label,
          (case when ${sql.raw(isModelSpan('s'))} then 'model' else 'harness' end) as kind,
          ${sql.raw(spanModel('s'))} as model,
          round((s.start_time_unix_nano - min(s.start_time_unix_nano) over ()) / 1e6)::float8
            as started_offset_ms,
          round(${sql.raw(spanDurationMs('s'))})::float8 as execution_time_ms,
          coalesce(${sql.raw(spanInputTokens('s'))}, 0)::float8 as input_token_count,
          coalesce(${sql.raw(spanOutputTokens('s'))}, 0)::float8 as output_token_count,
          coalesce(${sql.raw(spanCost('s'))}, 0)::numeric(14, 6)::text as total_cost,
          coalesce(${sql.raw(spanErrorCount('s'))}, 0)::float8 as errors,
          ${sql.raw(spanFailed('s'))} as failed,
          ${sql.raw(spanInput('s'))} as input,
          ${sql.raw(spanOutput('s'))} as output,
          s.start_time_unix_nano,
          s.end_time_unix_nano
        from scoped s
      )
      select ${sql.raw(REQUEST_COLUMNS)},
        m.median_cost,
        m.median_harness_cost,
        m.median_token_count,
        (
          select b.input from block_rows b
          where b.input is not null
          order by b.start_time_unix_nano, b.future_id
          limit 1
        ) as input,
        (
          select b.output from block_rows b
          where b.output is not null
          order by b.end_time_unix_nano desc, b.future_id desc
          limit 1
        ) as output,
        coalesce((
          select json_agg(json_build_object(
            'future_id', b.future_id,
            'label', b.label,
            'kind', b.kind,
            'model', b.model,
            'started_offset_ms', b.started_offset_ms,
            'execution_time_ms', b.execution_time_ms,
            'input_token_count', b.input_token_count,
            'output_token_count', b.output_token_count,
            'total_cost', b.total_cost,
            'errors', b.errors,
            'failed', b.failed
          ) order by b.start_time_unix_nano, b.future_id)
          from block_rows b
        ), '[]'::json) as blocks
      from requests q
      cross join medians m
    `);

    const row = (
      rows as unknown as [
        | (Omit<RequestTrace, 'input' | 'output'> & {
            blocks: RequestTraceBlock[];
            input: string | null;
            output: string | null;
          })
        | undefined,
      ]
    )[0];
    if (!row) return null;

    return { ...row, project_id, input: payload(row.input), output: payload(row.output) };
  },
};
