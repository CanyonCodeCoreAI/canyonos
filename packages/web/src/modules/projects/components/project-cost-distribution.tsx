import { useQuery } from '@tanstack/react-query';

import type { DistributionMetric, MetricsDistribution, MetricsWindow } from '@canyonos/api/metrics';

import { BarChart } from '@repo/ui/components/charts/bar-chart';
import { TimeRangeToggle } from '@repo/ui/components/time-range-toggle';
import { Skeleton } from '@repo/ui/shadcn/skeleton';
import type { BarDatum, BarMarker } from '@repo/ui/components/charts/bar-chart';
import type { ChartConfig } from '@repo/ui/shadcn/chart';
import { apiCall, forgeAuthApi } from '@/api';
import { EmptyState } from '@/modules/core/components/EmptyState';
import { QueryError } from '@/modules/core/components/QueryError';
import { ProjectMetricsSection } from '@/modules/projects/components/project-metrics-section';
import { formatCount } from '@/modules/projects/projects.format';
import {
  COST_SPLIT,
  DISTRIBUTION_BUCKETS,
  DISTRIBUTION_METRIC_FORMATTER,
  DISTRIBUTION_METRIC_OPTIONS,
  DISTRIBUTION_METRIC_TITLE,
  distributionBucketIndex,
  isDistributionMetric,
} from '@/modules/projects/projects.metrics';
import { dashboardPollInterval, projectQueryKeys } from '@/modules/projects/projects.query-cache';
import type { DistributionSelection } from '@/modules/projects/projects.metrics';

const CHART_CONFIG: ChartConfig = { value: { label: 'Queries', color: COST_SPLIT.llm_cost.color } };
const BAR_COLOR = COST_SPLIT.llm_cost.color;

/** How many of the dearest bins lead to an analysis when picked. */
const ANALYZED_BUCKETS = 2;

// Percentiles ride on the bar that contains them: equal-width bins make an exact x position
// meaningless on a categorical axis, but "this bar is where p95 lands" is exactly true.
const PERCENTILE_MARKERS = [
  { id: 'p50', label: 'p50' },
  { id: 'p95', label: 'p95' },
  { id: 'p99', label: 'p99' },
] as const satisfies readonly {
  id: keyof Pick<MetricsDistribution, 'p50' | 'p95' | 'p99'>;
  label: string;
}[];

interface ProjectCostDistributionProps {
  readonly project_id: string;
  readonly time_window: MetricsWindow;
  readonly metric: DistributionMetric;
  readonly selection: DistributionSelection | null;
  readonly onMetricChange: (metric: DistributionMetric) => void;
  readonly onSelect: (selection: DistributionSelection | null) => void;
}

export function ProjectCostDistribution({
  project_id,
  time_window,
  metric,
  selection,
  onMetricChange,
  onSelect,
}: ProjectCostDistributionProps) {
  const distribution_query = useQuery({
    queryKey: projectQueryKeys.metricsDistribution(
      project_id,
      metric,
      time_window,
      DISTRIBUTION_BUCKETS
    ),
    queryFn: () =>
      apiCall<MetricsDistribution>(() =>
        forgeAuthApi.projects[project_id]!.metrics.distribution.get({
          $query: { metric, time_window, buckets: DISTRIBUTION_BUCKETS },
        })
      ),
    retry: false,
    refetchInterval: dashboardPollInterval,
  });

  return (
    <ProjectMetricsSection
      title={`Per-query distribution · ${DISTRIBUTION_METRIC_TITLE[metric]}`}
      className="border-border/70 p-5 lg:border-r"
      description="Bar height is the share of queries that landed in that range, with p50, p95 and p99 marked."
      test_id="project-distribution"
      action={
        <TimeRangeToggle
          value={metric}
          onValueChange={(next) => {
            if (!isDistributionMetric(next)) return;
            onMetricChange(next);
          }}
          options={DISTRIBUTION_METRIC_OPTIONS}
          aria-label="Distribution metric"
          data-testid="project-distribution-metric"
        />
      }
    >
      {distribution_query.isPending ? (
        <Skeleton className="h-72 rounded-2xl" data-testid="project-distribution-loading" />
      ) : distribution_query.error ? (
        <QueryError
          message="Could not load the per-query distribution."
          onRetry={() => void distribution_query.refetch()}
          test_id="project-distribution-error"
        />
      ) : (
        <DistributionChart
          distribution={distribution_query.data}
          time_window={time_window}
          selection={selection}
          onSelect={onSelect}
        />
      )}
    </ProjectMetricsSection>
  );
}

function Figure({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-muted-foreground text-[0.6875rem] font-bold tracking-[0.06em] uppercase">
        {label}
      </dt>
      <dd className="text-foreground font-mono text-sm font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function DistributionChart({
  distribution,
  time_window,
  selection,
  onSelect,
}: {
  readonly distribution: MetricsDistribution;
  readonly time_window: MetricsWindow;
  readonly selection: DistributionSelection | null;
  readonly onSelect: (selection: DistributionSelection | null) => void;
}) {
  const format = DISTRIBUTION_METRIC_FORMATTER[distribution.metric];

  if (distribution.request_count === 0 || distribution.buckets.length === 0) {
    return (
      <EmptyState size="section" test_id="project-distribution-empty">
        <p>No completed queries in this window to build a distribution from.</p>
      </EmptyState>
    );
  }

  const bars: BarDatum[] = distribution.buckets.map((bucket, index) => ({
    key: `bucket-${index}`,
    label: format(bucket.lower),
    value: (bucket.count / distribution.request_count) * 100,
    color: BAR_COLOR,
  }));

  const analyzed = analyzedBuckets(distribution);

  const markers: BarMarker[] = [];
  for (const marker of PERCENTILE_MARKERS) {
    const percentile = distribution[marker.id];
    const index = distributionBucketIndex(percentile, distribution.buckets);
    const bar = index === undefined ? undefined : bars[index];
    if (percentile !== null && bar) {
      markers.push({
        key: marker.id,
        at: bar.label,
        label: `${marker.label} ${format(percentile)}`,
      });
    }
  }

  return (
    <div className="flex flex-col gap-4" data-testid="project-distribution-chart">
      <dl
        className="flex flex-wrap items-center gap-x-5 gap-y-2"
        data-testid="project-distribution-figures"
      >
        <Figure label="Mean" value={distribution.mean === null ? '—' : format(distribution.mean)} />
        <Figure label="Queries" value={formatCount(distribution.request_count)} />
      </dl>

      <div className="h-64 w-full">
        <BarChart
          data={bars}
          config={CHART_CONFIG}
          showValueLabels={false}
          valueFormatter={(value) => `${value.toFixed(1)}% of queries`}
          axisFormatter={(value) => `${value.toFixed(0)}%`}
          xTickInterval={Math.max(0, Math.ceil(bars.length / 5) - 1)}
          selectedKey={selection?.bucket_key}
          onBarSelect={(datum) => {
            const index = bars.indexOf(datum);
            const bucket = distribution.buckets[index];
            if (!bucket) return;
            if (selection?.bucket_key === datum.key) return onSelect(null);
            onSelect({
              metric: distribution.metric,
              time_window,
              min: bucket.lower,
              max: bucket.upper,
              label: `${format(bucket.lower)} – ${format(bucket.upper)}`,
              bucket_key: datum.key,
              analyzable: analyzed.includes(index),
            });
          }}
          markers={markers}
        />
      </div>
    </div>
  );
}

/**
 * The bins that lead to an analysis: the dearest two that actually hold queries.
 *
 * Dearest, not tallest — the tall bins are the ordinary cheap queries, and there is nothing to save
 * there. Empty bins are skipped because the top of a cost distribution is mostly empty tail, and a
 * bin nothing landed in would offer an analysis of no queries.
 */
function analyzedBuckets(distribution: MetricsDistribution): readonly number[] {
  return distribution.buckets
    .map((bucket, index) => ({ bucket, index }))
    .filter(({ bucket }) => bucket.count > 0)
    .toSorted((left, right) => right.index - left.index)
    .slice(0, ANALYZED_BUCKETS)
    .map(({ index }) => index);
}
