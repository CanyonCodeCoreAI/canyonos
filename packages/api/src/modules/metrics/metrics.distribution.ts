import { spanCost, spanTotalTokens } from './metrics.sql';
import type { DistributionMetric } from './metrics.types';

interface DistributionValue {
  readonly value: string;
  readonly having: string;
}

// Requires `otel_spans` rows aliased `s`, grouped by `s.trace_id`.
export const OTEL_DISTRIBUTION_VALUES: Record<DistributionMetric, DistributionValue> = {
  tokens_per_request: { value: `coalesce(sum(${spanTotalTokens('s')}), 0)::float8`, having: '' },
  // Only the requests that priced themselves: one whose spans report no cost did not cost nothing.
  cost_per_request: {
    value: `sum(${spanCost('s')})::float8`,
    having: `having bool_or(${spanCost('s')} is not null)`,
  },
  latency: {
    value: `round((max(s.end_time_unix_nano) - min(s.start_time_unix_nano)) / 1e6)::float8`,
    having: '',
  },
};

/**
 * One metric's distribution as SQL text: the `ctes` a query composes into its `with` list, and the
 * `json` scalar subquery that reads them back. `source` must be a span relation aliased `s`.
 *
 * `width_bucket` puts a value equal to the high bound in bucket count+1, so the top value is
 * clamped back into the last bucket; a degenerate distribution (min = max) collapses to a single
 * bucket because `width_bucket` rejects equal bounds.
 */
export const distribution_sql = ({
  metric,
  source,
  buckets,
}: {
  metric: DistributionMetric;
  source: string;
  buckets: number;
}): { ctes: string; json: string } => {
  // Bucket counts are inlined rather than bound, because they appear inside CTE text the caller
  // splices in raw. Boundary schemas already cap them; this keeps that invariant next to the SQL.
  if (!Number.isInteger(buckets) || buckets < 1) {
    throw new Error(`distribution buckets must be a positive integer, got ${String(buckets)}`);
  }
  const { value, having } = OTEL_DISTRIBUTION_VALUES[metric];

  return {
    ctes: `${metric}_values as (
        select ${value} as value
        from ${source}
        group by s.trace_id
        ${having}
      ),
      ${metric}_stats as (
        select
          count(*)::int as request_count,
          avg(value)::float8 as mean,
          stddev_samp(value)::float8 as std,
          min(value)::float8 as min,
          max(value)::float8 as max,
          percentile_cont(array[0.5, 0.95, 0.99]) within group (order by value) as pcts
        from ${metric}_values
      ),
      ${metric}_histogram as (
        select
          case
            when s.max = s.min then 1
            else least(width_bucket(v.value, s.min, s.max, ${buckets}), ${buckets})
          end as bucket,
          count(*)::int as count
        from ${metric}_values v cross join ${metric}_stats s
        group by 1
      )`,
    json: `(
        select json_build_object(
          'request_count', s.request_count,
          'mean', s.mean,
          'std', s.std,
          'min', s.min,
          'max', s.max,
          'p50', (s.pcts)[1]::float8,
          'p95', (s.pcts)[2]::float8,
          'p99', (s.pcts)[3]::float8,
          'buckets', case
            when s.request_count = 0 then '[]'::json
            else (
              select json_agg(json_build_object(
                'lower', s.min + (b - 1) * (s.max - s.min) / t.bucket_total,
                'upper', case
                  when b = t.bucket_total then s.max
                  else s.min + b * (s.max - s.min) / t.bucket_total
                end,
                'count', coalesce(h.count, 0)
              ) order by b)
              from (select case when s.max = s.min then 1 else ${buckets} end as bucket_total) t
              cross join generate_series(1, t.bucket_total) b
              left join ${metric}_histogram h on h.bucket = b
            )
          end
        )
        from ${metric}_stats s
      )`,
  };
};
