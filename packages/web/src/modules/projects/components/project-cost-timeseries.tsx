import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';

import type {
  KpiWindow,
  MetricsKpis,
  MetricsTimeseries,
  MetricsWindow,
} from '@cc-forge/api/metrics';

import { TimeseriesChart } from '@repo/ui/components/charts/timeseries-chart';
import { Legend } from '@repo/ui/components/legend';
import { StatCard } from '@repo/ui/components/stat-card';
import { Skeleton } from '@repo/ui/shadcn/skeleton';
import { TooltipProvider } from '@repo/ui/shadcn/tooltip';
import type { ChartConfig } from '@repo/ui/shadcn/chart';
import { apiCall, forgeAuthApi } from '@/api';
import { EmptyState } from '@/modules/core/components/EmptyState';
import { QueryError } from '@/modules/core/components/QueryError';
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
import {
  COST_SPLIT,
  LOCAL_TIME_ZONE,
  METRICS_WINDOW_DAYS,
} from '@/modules/projects/projects.metrics';
import { projectKpisQueryOptions } from '@/modules/projects/projects.queries';
import { dashboardPollInterval, projectQueryKeys } from '@/modules/projects/projects.query-cache';
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

const HOURS_PER_DAY = 24;

const TIME_WINDOW_BUCKETS: Partial<Record<MetricsWindow, number>> = { '7d': 7 };

const timeseriesQuery = (project_id: string, time_window: MetricsWindow) => {
  const buckets = TIME_WINDOW_BUCKETS[time_window];
  return {
    queryKey: projectQueryKeys.metricsTimeseries(project_id, time_window, LOCAL_TIME_ZONE),
    queryFn: () =>
      apiCall<MetricsTimeseries>(() =>
        forgeAuthApi.projects[project_id]!.metrics.timeseries.get({
          // Eden serialises an undefined query value to the literal string "undefined".
          $query: {
            time_window,
            time_zone: LOCAL_TIME_ZONE,
            ...(buckets === undefined ? {} : { buckets }),
          },
        })
      ),
    retry: false,
    refetchInterval: dashboardPollInterval,
  };
};

const DAY_SECONDS = 86_400;
const DAY_PARTS = { month: 'short', day: 'numeric', timeZone: LOCAL_TIME_ZONE } as const;
const HOUR_PARTS = { hour: 'numeric', timeZone: LOCAL_TIME_ZONE } as const;

const dayOf = (date: Date) => date.toLocaleDateString('en-US', DAY_PARTS);
const hourOf = (date: Date) => date.toLocaleTimeString('en-US', HOUR_PARTS);

/** Everything the chart reads. The agent drawer serves the same points without the envelope. */
export type TimeseriesPlot = Pick<MetricsTimeseries, 'points' | 'bucket_seconds'>;

function bucketLabeller({ points, bucket_seconds }: TimeseriesPlot): (index: number) => string {
  const spans_days = bucket_seconds >= 2 * DAY_SECONDS;
  const covers_a_day = bucket_seconds >= DAY_SECONDS;

  return (index) => {
    const start = new Date(points[index]?.start_at ?? '');
    if (Number.isNaN(start.getTime())) return '';
    if (spans_days) {
      const end = new Date(start);
      end.setDate(end.getDate() + bucket_seconds / DAY_SECONDS);
      end.setSeconds(end.getSeconds() - 1);
      return `${dayOf(start)} – ${dayOf(end)}`;
    }
    return covers_a_day ? dayOf(start) : hourOf(start);
  };
}

interface ProjectCostTimeseriesProps {
  readonly project_id: string;
  readonly time_window: MetricsWindow;
  /** Off when the section is already inside a card, as it is on the spend Overview tab. */
  readonly framed?: boolean;
}

export function ProjectCostTimeseries({
  project_id,
  time_window,
  framed = true,
}: ProjectCostTimeseriesProps) {
  const timeseries_query = useQuery(timeseriesQuery(project_id, time_window));
  const kpis_query = useQuery(projectKpisQueryOptions(project_id));
  const totals = kpis_query.data?.windows[time_window];

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
        <TimeseriesStatsPanel query={kpis_query} time_window={time_window} />
      </div>
    </ProjectMetricsSection>
  );
}

function TimeseriesChartPanel({
  query,
  totals,
}: {
  readonly query: UseQueryResult<MetricsTimeseries>;
  /** The same window's KPI totals, only to derive the chart's coverage state. */
  readonly totals: KpiWindow | undefined;
}) {
  if (query.isPending) {
    return (
      <Skeleton
        className={`${CHART_MIN_HEIGHT} rounded-2xl`}
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
  time_window,
}: {
  readonly query: UseQueryResult<MetricsKpis>;
  readonly time_window: MetricsWindow;
}) {
  if (query.isPending) {
    return (
      <div className={STATS_RAIL} aria-busy data-testid="project-timeseries-stats-loading">
        {['queries', 'run-rate', 'tokens', 'per-query', 'recoverable'].map((key) => (
          <Skeleton key={key} className="h-[3.375rem] rounded-xl" />
        ))}
      </div>
    );
  }

  if (query.error) {
    return (
      <QueryError
        message="Could not load cost totals for this window."
        onRetry={() => void query.refetch()}
        test_id="project-timeseries-stats-error"
      />
    );
  }

  return <TimeseriesStats totals={query.data.windows[time_window]} time_window={time_window} />;
}

export function CostTimeseriesChart({
  timeseries,
  coverage,
  test_id_prefix = 'project-timeseries',
  empty_message = 'No queries ran in this window, so there is no spend to plot.',
}: {
  /**
   * Optional because a deployed client can outrun the API behind it: main reaches staging while
   * only a release reaches demo, so a build that reads a new series can meet one that does not
   * serve it. An absent series draws the empty state; it must never throw.
   */
  readonly timeseries: TimeseriesPlot | undefined;
  /**
   * The KPI window's coverage, so an unpriced-but-run window reads as "not priced" rather than
   * "nothing ran". Absent for callers with no KPI window (the per-agent drawer), which fall back
   * to the request-count check instead.
   */
  readonly coverage?: CostCoverage;
  /** Namespaces the chart's test ids so two of them on one screen stay addressable. */
  readonly test_id_prefix?: string;
  readonly empty_message?: string;
}) {
  const points = timeseries?.points ?? [];

  if (timeseries === undefined || points.every((point) => point.request_count === 0)) {
    return (
      <EmptyState size="section" test_id={`${test_id_prefix}-empty`}>
        <p>{empty_message}</p>
      </EmptyState>
    );
  }

  if (coverage?.state === 'unavailable') {
    return (
      <EmptyState size="section" test_id={`${test_id_prefix}-unpriced`}>
        <p>No blocks in this window report cost data, so there is no spend to plot.</p>
      </EmptyState>
    );
  }

  const bucketLabel = bucketLabeller(timeseries);

  const data = points.map((point, index) => ({
    index,
    harness_cost: parseMoney(point.harness_cost),
    llm_cost: parseMoney(point.llm_cost),
  }));
  const maxValue = Math.max(...points.map((point) => parseMoney(point.total_cost)), 0);

  return (
    <div
      className="border-border/70 bg-card min-w-0 rounded-[1.125rem] border p-5 shadow-xs"
      data-testid={`${test_id_prefix}-chart`}
    >
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
    </div>
  );
}

function TimeseriesStats({
  totals,
  time_window,
}: {
  readonly totals: KpiWindow;
  readonly time_window: MetricsWindow;
}) {
  // A run rate is spend divided by the window's own length, so the figure stays comparable when
  // the range changes. A single day reads per hour; anything longer reads per day.
  const days = METRICS_WINDOW_DAYS[time_window];
  const per_hour = time_window === '1d';
  const unavailable = costCoverage(totals).state === 'unavailable';

  // run_rate is computed client-side, not read off the payload, so it needs its own null-out —
  // formatMoney can't null a plain number.
  const run_rate_display = unavailable
    ? formatMoney(null)
    : `${formatMoneyValue(parseMoney(totals.total_cost) / (per_hour ? HOURS_PER_DAY : days))} / ${per_hour ? 'hour' : 'day'}`;
  const recoverable_cost = unavailable ? null : totals.recoverable_cost;

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
          hint={`over ${per_hour ? '24 hours' : `${days} days`}`}
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
