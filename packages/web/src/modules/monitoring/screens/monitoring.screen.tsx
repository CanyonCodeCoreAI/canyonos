// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { useQuery } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import type { UseQueryResult } from '@tanstack/react-query';

import type { MonitoringSeries, MonitoringSeriesResponse } from '@canyonos/api/monitoring';

import { TimeseriesChart } from '@repo/ui/components/charts/timeseries-chart';
import { TimeRangeToggle } from '@repo/ui/components/time-range-toggle';
import { cardVariants } from '@repo/ui/shadcn/card';
import { Skeleton } from '@repo/ui/shadcn/skeleton';
import type { TimeRangeOption } from '@repo/ui/components/time-range-toggle';
import type { ChartConfig } from '@repo/ui/shadcn/chart';
import { EmptyState } from '@/modules/core/components/EmptyState';
import { QueryError } from '@/modules/core/components/QueryError';
import { dailyTickInterval, formatBucketLabel, LOCAL_TIME_ZONE } from '@/modules/core/time-range';
import { LlmCallList } from '@/modules/monitoring/components/llm-call-list';
import { TraceList } from '@/modules/monitoring/components/trace-list';
import {
  formatSignalValue,
  monitoringSeriesQueryOptions,
  SIGNAL_LABELS,
  UNIT_AXIS_LABELS,
} from '@/modules/monitoring/monitoring.queries';
import { ProjectWindowControl } from '@/modules/projects/components/project-window-control';
import type { RangeSelection } from '@/modules/core/time-range';
import type { TraceView } from '@/modules/monitoring/monitoring.search';

const SIGNAL_COLORS = {
  traffic: 'var(--signal-traffic)',
  latency: 'var(--signal-latency)',
} as const;

const VIEW_OPTIONS = [
  { value: 'traces', label: 'All traces' },
  { value: 'llm_calls', label: 'LLM calls' },
] as const satisfies readonly TimeRangeOption<TraceView>[];

const route = getRouteApi('/_authenticated/projects/$project_id/monitoring');

type ShownSignal = keyof typeof SIGNAL_COLORS;

type ShownSeries = MonitoringSeries & { signal: ShownSignal };

const isShown = (series: MonitoringSeries): series is ShownSeries => series.signal in SIGNAL_COLORS;

interface MonitoringScreenProps {
  readonly project_id: string;
  readonly range: RangeSelection;
  readonly view: TraceView;
}

export function MonitoringScreen({ project_id, range, view }: MonitoringScreenProps) {
  const query = useQuery(
    monitoringSeriesQueryOptions(project_id, { range, time_zone: LOCAL_TIME_ZONE })
  );
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
          onValueChange={(next) =>
            void navigate({ search: (previous) => ({ ...previous, view: next }) })
          }
          options={VIEW_OPTIONS}
          aria-label="Trace view"
          data-testid="trace-view-toggle"
          className="self-start"
        />
        <TraceViewPanel project_id={project_id} range={range} view={view} />
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
  range,
  view,
}: {
  readonly project_id: string;
  readonly range: RangeSelection;
  readonly view: TraceView;
}) {
  if (view === 'llm_calls') return <LlmCallList project_id={project_id} range={range} />;
  return <TraceList project_id={project_id} range={range} />;
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
            xTickFormatter={(index) =>
              formatBucketLabel(bucket_start_ats[index]!, bucket_seconds, { short: true })
            }
            xTickInterval={dailyTickInterval(bucket_seconds)}
            xAxisLabel="Time"
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
