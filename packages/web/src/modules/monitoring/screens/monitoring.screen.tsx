import { useQuery } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import type { UseQueryResult } from '@tanstack/react-query';

import type { MetricsWindow } from '@canyonos/api/metrics';
import type { MonitoringSeries, MonitoringSeriesResponse } from '@canyonos/api/monitoring';

import { TimeseriesChart } from '@repo/ui/components/charts/timeseries-chart';
import { TimeRangeToggle } from '@repo/ui/components/time-range-toggle';
import { cardVariants } from '@repo/ui/shadcn/card';
import { Skeleton } from '@repo/ui/shadcn/skeleton';
import type { TimeRangeOption } from '@repo/ui/components/time-range-toggle';
import type { ChartConfig } from '@repo/ui/shadcn/chart';
import { EmptyState } from '@/modules/core/components/EmptyState';
import { QueryError } from '@/modules/core/components/QueryError';
import { LlmCallList } from '@/modules/monitoring/components/llm-call-list';
import { TraceList } from '@/modules/monitoring/components/trace-list';
import {
  formatBucketLabel,
  formatSignalValue,
  monitoringSeriesQueryOptions,
  SIGNAL_LABELS,
  UNIT_AXIS_LABELS,
} from '@/modules/monitoring/monitoring.queries';
import { ProjectWindowControl } from '@/modules/projects/components/project-window-control';
import type { TraceView } from '@/modules/monitoring/monitoring.search';

const SIGNAL_COLORS = {
  traffic: 'var(--signal-traffic)',
  latency: 'var(--signal-latency)',
} as const;

const X_TICK_INTERVAL = 2;

const VIEW_OPTIONS = [
  { value: 'traces', label: 'All traces' },
  { value: 'llm_traces', label: 'With LLM calls' },
  { value: 'llm_calls', label: 'LLM calls' },
] as const satisfies readonly TimeRangeOption<TraceView>[];

const route = getRouteApi('/_authenticated/projects/$project_id/monitoring');

type ShownSignal = keyof typeof SIGNAL_COLORS;

type ShownSeries = MonitoringSeries & { signal: ShownSignal };

const isShown = (series: MonitoringSeries): series is ShownSeries => series.signal in SIGNAL_COLORS;

interface MonitoringScreenProps {
  readonly project_id: string;
  readonly time_window: MetricsWindow;
  readonly view: TraceView;
}

export function MonitoringScreen({ project_id, time_window, view }: MonitoringScreenProps) {
  const query = useQuery(monitoringSeriesQueryOptions(project_id, time_window));
  const navigate = route.useNavigate();

  return (
    <main className="flex min-h-full shrink-0 flex-col gap-7 p-7" data-testid="monitoring-screen">
      <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <h1 className="text-foreground text-[1.5rem] leading-none font-bold tracking-tight">
          Traces
        </h1>
        <ProjectWindowControl />
      </header>

      <SignalGrid query={query} />

      <section className="flex min-w-0 flex-col gap-3">
        <TimeRangeToggle
          value={view}
          onValueChange={(next) => void navigate({ search: { time_window, view: next } })}
          options={VIEW_OPTIONS}
          aria-label="Trace view"
          data-testid="trace-view-toggle"
          className="self-start"
        />
        <TraceViewPanel project_id={project_id} time_window={time_window} view={view} />
      </section>
    </main>
  );
}

function SignalGrid({ query }: { readonly query: UseQueryResult<MonitoringSeriesResponse> }) {
  if (query.isPending) {
    return (
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {[0, 1].map((slot) => (
          <Skeleton key={slot} className="h-72 w-full rounded-lg" />
        ))}
      </div>
    );
  }
  if (query.isError) {
    return (
      <QueryError
        message="Could not load trace signals."
        onRetry={() => void query.refetch()}
        test_id="monitoring-error"
      />
    );
  }
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2" data-testid="monitoring-grid">
      {query.data.series.filter(isShown).map((series) => (
        <SignalQuadrant
          key={series.signal}
          series={series}
          bucket_start_ats={query.data.bucket_start_ats}
          bucket_seconds={query.data.bucket_seconds}
        />
      ))}
    </div>
  );
}

function TraceViewPanel({
  project_id,
  time_window,
  view,
}: {
  readonly project_id: string;
  readonly time_window: MetricsWindow;
  readonly view: TraceView;
}) {
  if (view === 'llm_calls')
    return <LlmCallList project_id={project_id} time_window={time_window} />;
  return <TraceList project_id={project_id} time_window={time_window} />;
}

function SignalQuadrant({
  series,
  bucket_start_ats,
  bucket_seconds,
}: {
  readonly series: ShownSeries;
  readonly bucket_start_ats: readonly string[];
  readonly bucket_seconds: number;
}) {
  const label = SIGNAL_LABELS[series.signal];
  const config: ChartConfig = { value: { label, color: SIGNAL_COLORS[series.signal] } };

  return (
    <section
      className={cardVariants({ className: 'min-w-0 p-5' })}
      data-testid={`monitoring-quadrant-${series.signal}`}
    >
      <h2 className="text-foreground mb-4 text-sm font-semibold">{label}</h2>
      {series.samples === 0 ? (
        <EmptyState size="section" test_id={`monitoring-quadrant-${series.signal}-empty`}>
          Nothing recorded for this signal in the selected window.
        </EmptyState>
      ) : (
        <div className="h-60 w-full">
          <TimeseriesChart
            data={series.values.map((value, index) => ({ index, value }))}
            config={config}
            mark="line"
            maxValue={series.peak !== null && series.peak > 0 ? series.peak : 1}
            axisFormatter={(value) => formatSignalValue(value, series.unit)}
            valueFormatter={(value) => formatSignalValue(value, series.unit)}
            xTickFormatter={(index) => formatBucketLabel(bucket_start_ats[index]!, bucket_seconds)}
            xTickInterval={X_TICK_INTERVAL}
            xAxisLabel={bucket_seconds >= 86_400 ? 'Time (day)' : 'Time (hour)'}
            yAxisLabel={UNIT_AXIS_LABELS[series.unit]}
            labelFormatter={(point) =>
              formatBucketLabel(bucket_start_ats[point.index]!, bucket_seconds)
            }
          />
        </div>
      )}
    </section>
  );
}
