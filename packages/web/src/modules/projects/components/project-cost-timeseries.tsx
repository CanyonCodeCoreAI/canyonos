// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';

import type { MetricsKpi, MetricsKpis, MetricsTimeseries } from '@canyonos/api/metrics';

import { TimeseriesChart } from '@repo/ui/components/charts/timeseries-chart';
import { Legend } from '@repo/ui/components/legend';
import { StatCard } from '@repo/ui/components/stat-card';
import { Card } from '@repo/ui/shadcn/card';
import { Skeleton } from '@repo/ui/shadcn/skeleton';
import { TooltipProvider } from '@repo/ui/shadcn/tooltip';
import type { ChartConfig } from '@repo/ui/shadcn/chart';
import { EmptyState } from '@/modules/core/components/EmptyState';
import { QueryError } from '@/modules/core/components/QueryError';
import { formatBucketLabel, LOCAL_TIME_ZONE, rangeLabel } from '@/modules/core/time-range';
import { costCoverage, CostCoverageBadge } from '@/modules/projects/components/project-cost-ribbon';
import { ProjectMetricsSection } from '@/modules/projects/components/project-metrics-section';
import {
  formatCount,
  formatMoney,
  formatMoneyValue,
  formatShare,
  formatTokens,
  parseMoney,
} from '@/modules/projects/projects.format';
import { COST_SPLIT } from '@/modules/projects/projects.metrics';
import {
  projectKpisQueryOptions,
  projectTimeseriesQueryOptions,
} from '@/modules/projects/projects.queries';
import type { RangeSelection } from '@/modules/core/time-range';
import type { CostCoverage } from '@/modules/projects/components/project-cost-ribbon';

const SERIES = ['harness_cost', 'llm_cost'] as const;

const CHART_CONFIG: ChartConfig = {
  harness_cost: { label: COST_SPLIT.harness_cost.label, color: COST_SPLIT.harness_cost.color },
  llm_cost: { label: COST_SPLIT.llm_cost.label, color: COST_SPLIT.llm_cost.color },
};

const LEGEND_ITEMS = [...SERIES].reverse().map((key) => ({
  id: key,
  label: COST_SPLIT[key].label,
  color: COST_SPLIT[key].color,
}));

const STATS_RAIL =
  'grid gap-[0.8125rem] [grid-template-columns:repeat(auto-fit,minmax(11rem,1fr))] xl:grid-cols-1 xl:content-between';

const CHART_MIN_HEIGHT = 'h-full min-h-72';

/** Everything the chart reads. The agent drawer serves the same points without the envelope. */
export type TimeseriesPlot = Pick<MetricsTimeseries, 'points' | 'bucket_seconds'>;

interface ProjectCostTimeseriesProps {
  readonly project_id: string;
  readonly range: RangeSelection;
  /** Off when the section is already inside a card, as it is on the spend Overview tab. */
  readonly framed?: boolean;
}

export function ProjectCostTimeseries({
  project_id,
  range,
  framed = true,
}: ProjectCostTimeseriesProps) {
  const timeseries_query = useQuery(
    projectTimeseriesQueryOptions(project_id, { range, time_zone: LOCAL_TIME_ZONE })
  );
  const kpis_query = useQuery(projectKpisQueryOptions(project_id, { range }));
  const totals = kpis_query.data;

  return (
    <ProjectMetricsSection
      title="Cost trends"
      description="Spend per bucket, model tokens stacked over harness and compute."
      test_id="project-cost-timeseries"
      framed={framed}
      action={
        timeseries_query.data ? (
          <Legend items={LEGEND_ITEMS} data-testid="project-timeseries-legend" />
        ) : null
      }
    >
      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_17rem]">
        <TimeseriesChartPanel query={timeseries_query} totals={totals} />
        <TimeseriesStatsPanel query={kpis_query} range={range} />
      </div>
    </ProjectMetricsSection>
  );
}

function TimeseriesChartPanel({
  query,
  totals,
}: {
  readonly query: UseQueryResult<MetricsTimeseries>;
  /** The same range's KPI totals, only to derive the chart's coverage state. */
  readonly totals: MetricsKpi | undefined;
}) {
  if (query.isPending) {
    return (
      <Skeleton
        className={`${CHART_MIN_HEIGHT} rounded-lg`}
        data-testid="project-timeseries-loading"
      />
    );
  }

  if (query.error) {
    return (
      <QueryError
        message="Could not load the cost timeline."
        onRetry={() => void query.refetch()}
        test_id="project-timeseries-error"
      />
    );
  }

  return (
    <CostTimeseriesChart
      timeseries={query.data}
      coverage={totals ? costCoverage(totals) : undefined}
    />
  );
}

function TimeseriesStatsPanel({
  query,
  range,
}: {
  readonly query: UseQueryResult<MetricsKpis>;
  readonly range: RangeSelection;
}) {
  if (query.isPending) {
    return (
      <div className={STATS_RAIL} aria-busy data-testid="project-timeseries-stats-loading">
        {['queries', 'run-rate', 'tokens', 'per-query', 'recoverable'].map((key) => (
          <Skeleton key={key} className="h-[3.375rem] rounded-md" />
        ))}
      </div>
    );
  }

  if (query.error) {
    return (
      <QueryError
        message="Could not load cost totals for this range."
        onRetry={() => void query.refetch()}
        test_id="project-timeseries-stats-error"
      />
    );
  }

  return <TimeseriesStats totals={query.data} range={range} />;
}

export function CostTimeseriesChart({
  timeseries,
  coverage,
  test_id_prefix = 'project-timeseries',
  empty_message = 'No queries ran in this range, so there is no spend to plot.',
}: {
  readonly timeseries: TimeseriesPlot;
  /**
   * The KPI range's coverage, so an unpriced-but-run range reads as "not priced" rather than
   * "nothing ran". Absent for callers with no KPI totals (the per-agent drawer), which fall back
   * to the request-count check instead.
   */
  readonly coverage?: CostCoverage;
  /** Namespaces the chart's test ids so two of them on one screen stay addressable. */
  readonly test_id_prefix?: string;
  readonly empty_message?: string;
}) {
  const points = timeseries.points;

  if (points.every((point) => point.request_count === 0)) {
    return (
      <EmptyState size="section" test_id={`${test_id_prefix}-empty`}>
        <p>{empty_message}</p>
      </EmptyState>
    );
  }

  if (coverage?.state === 'unavailable') {
    return (
      <EmptyState size="section" test_id={`${test_id_prefix}-unpriced`}>
        <p>No blocks in this range report cost data, so there is no spend to plot.</p>
      </EmptyState>
    );
  }

  const bucketLabel = (index: number) =>
    formatBucketLabel(points[index]!.start_at, timeseries.bucket_seconds);

  const data = points.map((point, index) => ({
    index,
    harness_cost: parseMoney(point.harness_cost),
    llm_cost: parseMoney(point.llm_cost),
  }));
  const maxValue = Math.max(...points.map((point) => parseMoney(point.total_cost)), 0);

  return (
    <Card className="min-w-0 p-5" data-testid={`${test_id_prefix}-chart`}>
      <div className={`${CHART_MIN_HEIGHT} w-full`}>
        <TimeseriesChart
          data={data}
          config={CHART_CONFIG}
          series={SERIES}
          mark="bar"
          maxValue={maxValue > 0 ? maxValue : 1}
          axisFormatter={formatMoneyValue}
          valueFormatter={formatMoneyValue}
          xTickFormatter={bucketLabel}
          labelFormatter={(point) => bucketLabel(point.index)}
        />
      </div>
    </Card>
  );
}

function TimeseriesStats({
  totals,
  range,
}: {
  readonly totals: MetricsKpis;
  readonly range: RangeSelection;
}) {
  const run_rate_display =
    totals.run_rate === null
      ? formatMoney(null)
      : `${formatMoney(totals.run_rate)} / ${totals.run_rate_per}`;
  const recoverable_cost =
    costCoverage(totals).state === 'unavailable' ? null : totals.recoverable_cost;

  return (
    <TooltipProvider delayDuration={150}>
      <div className={STATS_RAIL} data-testid="project-timeseries-stats">
        <StatCard
          size="compact"
          data-testid="project-timeseries-queries"
          label="Queries"
          value={formatCount(totals.request_count)}
          hint={`${formatTokens(totals.tokens)} tokens billed`}
        />
        <StatCard
          size="compact"
          data-testid="project-timeseries-run-rate"
          label="Run rate"
          value={run_rate_display}
          hint={`over ${rangeLabel(range)}`}
          leading={<CostCoverageBadge kpi={totals} test_id="project-timeseries-run-rate" />}
        />
        <StatCard
          size="compact"
          data-testid="project-timeseries-tokens"
          label="Tokens"
          value={formatTokens(totals.tokens)}
          hint={`${formatTokens(totals.per_block_tokens)} per block`}
        />
        <StatCard
          size="compact"
          data-testid="project-timeseries-cost-per-query"
          label="Cost per query"
          value={formatMoney(totals.per_costed_request_cost)}
          hint={`${formatCount(totals.block_count)} blocks run`}
          leading={<CostCoverageBadge kpi={totals} test_id="project-timeseries-cost-per-query" />}
        />
        <StatCard
          size="compact"
          tone="danger"
          data-testid="project-timeseries-recoverable"
          label="Recoverable"
          value={formatMoney(recoverable_cost)}
          hint={`${formatShare(parseMoney(totals.recoverable_cost), parseMoney(totals.total_cost))} of spend`}
          leading={<CostCoverageBadge kpi={totals} test_id="project-timeseries-recoverable" />}
        />
      </div>
    </TooltipProvider>
  );
}
