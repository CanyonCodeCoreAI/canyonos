// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';

import type { DistributionMetric, MetricsDistribution } from '@canyonos/api/metrics';

import { BarChart } from '@repo/ui/components/charts/bar-chart';
import { TimeRangeToggle } from '@repo/ui/components/time-range-toggle';
import { Skeleton } from '@repo/ui/shadcn/skeleton';
import type { BarDatum, BarMarker } from '@repo/ui/components/charts/bar-chart';
import type { ChartConfig } from '@repo/ui/shadcn/chart';
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
import { projectDistributionQueryOptions } from '@/modules/projects/projects.queries';
import type { RangeSelection } from '@/modules/core/time-range';
import type { DistributionSelection } from '@/modules/projects/projects.metrics';

const CHART_CONFIG: ChartConfig = { value: { label: 'Queries', color: COST_SPLIT.llm_cost.color } };
const BAR_COLOR = COST_SPLIT.llm_cost.color;

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
  readonly range: RangeSelection;
  readonly metric: DistributionMetric;
  readonly selection: DistributionSelection | null;
  readonly onMetricChange: (metric: DistributionMetric) => void;
  readonly onSelect: (selection: DistributionSelection | null) => void;
}

export function ProjectCostDistribution({
  project_id,
  range,
  metric,
  selection,
  onMetricChange,
  onSelect,
}: ProjectCostDistributionProps) {
  const distribution_query = useQuery(
    projectDistributionQueryOptions(project_id, { range, metric, buckets: DISTRIBUTION_BUCKETS })
  );

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
      <DistributionBody query={distribution_query} selection={selection} onSelect={onSelect} />
    </ProjectMetricsSection>
  );
}

function DistributionBody({
  query,
  selection,
  onSelect,
}: {
  readonly query: UseQueryResult<MetricsDistribution>;
  readonly selection: DistributionSelection | null;
  readonly onSelect: (selection: DistributionSelection | null) => void;
}) {
  if (query.isPending) {
    return <Skeleton className="h-72 rounded-lg" data-testid="project-distribution-loading" />;
  }
  if (query.error) {
    return (
      <QueryError
        message="Could not load the per-query distribution."
        onRetry={() => void query.refetch()}
        test_id="project-distribution-error"
      />
    );
  }
  return <DistributionChart distribution={query.data} selection={selection} onSelect={onSelect} />;
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
  selection,
  onSelect,
}: {
  readonly distribution: MetricsDistribution;
  readonly selection: DistributionSelection | null;
  readonly onSelect: (selection: DistributionSelection | null) => void;
}) {
  const format = DISTRIBUTION_METRIC_FORMATTER[distribution.metric];

  if (distribution.request_count === 0 || distribution.buckets.length === 0) {
    return (
      <EmptyState size="section" test_id="project-distribution-empty">
        <p>No completed queries in this range to build a distribution from.</p>
      </EmptyState>
    );
  }

  const bars: BarDatum[] = distribution.buckets.map((bucket, index) => ({
    key: `bucket-${index}`,
    label: format(bucket.lower),
    value: (bucket.count / distribution.request_count) * 100,
    color: BAR_COLOR,
  }));

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
              min: bucket.lower,
              max: bucket.upper,
              label: `${format(bucket.lower)} – ${format(bucket.upper)}`,
              bucket_key: datum.key,
            });
          }}
          markers={markers}
        />
      </div>
    </div>
  );
}
