import type { MonitoringResource, MonitoringResourceEntry } from '@canyonos/api/monitoring';

import { TimeseriesChart } from '@repo/ui/components/charts/timeseries-chart';
import type { SeriesPoint } from '@repo/ui/components/charts/timeseries-chart';
import type { ChartConfig } from '@repo/ui/shadcn/chart';
import { EmptyState } from '@/modules/core/components/EmptyState';
import { formatBucketLabel } from '@/modules/monitoring/monitoring.queries';
import {
  RESOURCE_COLORS,
  RESOURCE_LABELS,
  RESOURCE_ORDER,
} from '@/modules/monitoring/monitoring.resources';

const AXIS_MAX = 100;

export function ResourceLegend({
  resources,
}: {
  readonly resources: readonly MonitoringResource[];
}) {
  return (
    <ul className="flex flex-wrap items-center gap-x-5 gap-y-2" data-testid="metrics-legend">
      {RESOURCE_ORDER.filter((resource) => resources.includes(resource)).map((resource) => (
        <li key={resource} className="flex items-center gap-2">
          <span
            className="h-0.5 w-4 rounded-full"
            style={{ backgroundColor: RESOURCE_COLORS[resource] }}
            aria-hidden
          />
          <span className="text-muted-foreground text-xs">{RESOURCE_LABELS[resource]}</span>
        </li>
      ))}
    </ul>
  );
}

interface ResourceSectionProps {
  readonly title: string;
  readonly caption: string;
  readonly entries: readonly MonitoringResourceEntry[];
  readonly bucket_start_ats: readonly string[];
  readonly bucket_seconds: number;
  readonly empty_message: string;
  readonly test_id: string;
}

export function ResourceSection({
  title,
  caption,
  entries,
  bucket_start_ats,
  bucket_seconds,
  empty_message,
  test_id,
}: ResourceSectionProps) {
  return (
    <section className="flex min-w-0 flex-col" data-testid={test_id}>
      <header className="mb-4">
        <h2 className="text-foreground text-sm font-semibold">{title}</h2>
        <p className="text-muted-foreground mt-1 text-xs">{caption}</p>
      </header>

      {entries.length === 0 ? (
        <EmptyState size="section" test_id={`${test_id}-empty`}>
          {empty_message}
        </EmptyState>
      ) : (
        <div className="grid grid-cols-1 gap-x-6 gap-y-5 xl:grid-cols-2">
          {entries.map((entry) => (
            <EntryChart
              key={entry.key}
              entry={entry}
              bucket_start_ats={bucket_start_ats}
              bucket_seconds={bucket_seconds}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function EntryChart({
  entry,
  bucket_start_ats,
  bucket_seconds,
}: {
  readonly entry: MonitoringResourceEntry;
  readonly bucket_start_ats: readonly string[];
  readonly bucket_seconds: number;
}) {
  const config: ChartConfig = Object.fromEntries(
    entry.series.map((series) => [
      series.resource,
      { label: RESOURCE_LABELS[series.resource], color: RESOURCE_COLORS[series.resource] },
    ])
  );

  const data: SeriesPoint[] = bucket_start_ats.map((_, index) => ({
    index,
    ...Object.fromEntries(
      entry.series.map((series) => [series.resource, series.values[index] ?? null])
    ),
  }));

  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <span className="text-foreground truncate font-mono text-xs" title={entry.key}>
          {entry.key}
        </span>
        <span className="text-muted-foreground text-xs tabular-nums">
          {entry.series
            .map((series) => `${RESOURCE_LABELS[series.resource]} ${series.average.toFixed(0)}%`)
            .join(' · ')}
        </span>
      </div>
      <div className="h-40 w-full">
        <TimeseriesChart
          data={data}
          config={config}
          mark="line"
          series={entry.series.map((series) => series.resource)}
          maxValue={AXIS_MAX}
          axisFormatter={(value) => `${Math.round(value)}%`}
          valueFormatter={(value) => `${value.toFixed(1)}%`}
          xTickFormatter={(index) => formatBucketLabel(bucket_start_ats[index]!, bucket_seconds)}
          labelFormatter={(point) =>
            formatBucketLabel(bucket_start_ats[point.index]!, bucket_seconds)
          }
        />
      </div>
    </div>
  );
}
