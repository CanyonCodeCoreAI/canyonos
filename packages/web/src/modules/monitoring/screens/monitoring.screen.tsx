import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import type { MetricsWindow } from '@canyonos/api/metrics';
import type { MonitoringSeries } from '@canyonos/api/monitoring';

import { TimeseriesChart } from '@repo/ui/components/charts/timeseries-chart';
import { Skeleton } from '@repo/ui/shadcn/skeleton';
import type { ChartConfig } from '@repo/ui/shadcn/chart';
import { EmptyState } from '@/modules/core/components/EmptyState';
import { QueryError } from '@/modules/core/components/QueryError';
import { PALETTE } from '@/modules/core/navigation/navigation';
import { TraceList } from '@/modules/monitoring/components/trace-list';
import {
  formatBucketLabel,
  formatSignalValue,
  monitoringSeriesQueryOptions,
  SIGNAL_LABELS,
  UNIT_AXIS_LABELS,
} from '@/modules/monitoring/monitoring.queries';
import { ProjectWindowControl } from '@/modules/projects/components/project-window-control';
import { DEFAULT_METRICS_WINDOW } from '@/modules/projects/projects.metrics';

const SIGNAL_COLORS = {
  traffic: PALETTE.steel,
  latency: PALETTE.violet,
} as const;

const X_TICK_INTERVAL = 2;

type ShownSignal = keyof typeof SIGNAL_COLORS;

type ShownSeries = MonitoringSeries & { signal: ShownSignal };

const isShown = (series: MonitoringSeries): series is ShownSeries => series.signal in SIGNAL_COLORS;

interface MonitoringScreenProps {
  readonly project_id: string;
}

export function MonitoringScreen({ project_id }: MonitoringScreenProps) {
  const [time_window, setTimeWindow] = useState<MetricsWindow>(DEFAULT_METRICS_WINDOW);
  const query = useQuery(monitoringSeriesQueryOptions(project_id, time_window));

  return (
    <main className="flex min-h-full flex-col gap-7 p-7" data-testid="monitoring-screen">
      <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <h1 className="text-foreground text-[1.5rem] leading-none font-bold tracking-tight">
          Traces
        </h1>
        <ProjectWindowControl value={time_window} onChange={setTimeWindow} />
      </header>

      {query.error ? (
        <QueryError
          message="Could not load trace signals."
          onRetry={() => void query.refetch()}
          test_id="monitoring-error"
        />
      ) : query.isPending ? (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          {[0, 1].map((slot) => (
            <Skeleton key={slot} className="h-72 w-full rounded-[1.125rem]" />
          ))}
        </div>
      ) : (
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
      )}

      <section className="flex min-w-0 flex-col gap-3">
        <h2 className="text-foreground text-sm font-semibold">All traces</h2>
        <TraceList project_id={project_id} time_window={time_window} />
      </section>
    </main>
  );
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
  const measured = series.values.filter((value): value is number => value !== null);
  const max = measured.length > 0 ? Math.max(...measured) : 0;

  return (
    <section
      className="border-border/70 bg-card min-w-0 rounded-[1.125rem] border p-5 shadow-xs"
      data-testid={`monitoring-quadrant-${series.signal}`}
    >
      <h2 className="text-foreground mb-4 text-sm font-semibold">{label}</h2>
      {measured.length === 0 ? (
        <EmptyState size="section" test_id={`monitoring-quadrant-${series.signal}-empty`}>
          Nothing recorded for this signal in the selected window.
        </EmptyState>
      ) : (
        <div className="h-60 w-full">
          <TimeseriesChart
            data={series.values.map((value, index) => ({ index, value }))}
            config={config}
            mark="line"
            maxValue={max > 0 ? max : 1}
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
