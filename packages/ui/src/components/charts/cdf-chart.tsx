import * as React from 'react';
import { Area, CartesianGrid, ComposedChart, ReferenceDot, XAxis, YAxis } from 'recharts';

import { cn } from '../../lib/utils';
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '../../shadcn/chart';
import type { ChartConfig } from '../../shadcn/chart';

/**
 * One cumulative reading: `share`% of the population (`count` of them) sits at or under `value`.
 * Points must arrive sorted by `share` ascending, starting at the distribution's floor.
 */
export interface CdfPoint {
  readonly share: number;
  readonly count: number;
  readonly value: number;
}

/** A percentile called out on the curve itself, e.g. `p95` at share 95. */
export interface CdfMarker {
  readonly key: string;
  readonly share: number;
  readonly value: number;
  readonly label: string;
}

const NO_MARKERS: readonly CdfMarker[] = [];

const SHARE_TICKS = [0, 25, 50, 75, 100];

// A label centred on a marker this far right would run off the plot, so it hangs left instead.
const EDGE_MARKER_SHARE = 80;

export interface CdfChartProps extends Omit<React.ComponentProps<'div'>, 'children'> {
  readonly data: readonly CdfPoint[];
  readonly config: ChartConfig;
  readonly markers?: readonly CdfMarker[];
  /** Formats the metric the curve climbs through: the y axis, markers and tooltip. */
  readonly valueFormatter: (value: number) => string;
  /** Formats the count in the tooltip. Defaults to `toLocaleString`. */
  readonly countFormatter?: (count: number) => string;
}

/**
 * A cumulative distribution drawn as a quantile curve: x is how much of the population has been
 * counted, y is the value it all stays at or under. Steps land on measured bucket edges only —
 * nothing is interpolated between them.
 */
function CdfChart({
  data,
  config,
  markers = NO_MARKERS,
  valueFormatter,
  countFormatter,
  className,
  ...props
}: CdfChartProps) {
  const formatCount = countFormatter ?? ((count: number) => count.toLocaleString());

  return (
    <div className={cn('size-full', className)} {...props}>
      <ChartContainer config={config} className="aspect-auto size-full">
        <ComposedChart
          data={data as CdfPoint[]}
          margin={{ top: 18, right: 12, bottom: 0, left: 0 }}
        >
          <CartesianGrid vertical={false} strokeDasharray="5 5" />
          <YAxis
            dataKey="value"
            domain={[0, 'auto']}
            tickLine={false}
            axisLine={false}
            width={44}
            tickCount={4}
            tickFormatter={valueFormatter}
            tick={{ fontSize: 10 }}
          />
          <XAxis
            dataKey="share"
            type="number"
            domain={[0, 100]}
            ticks={SHARE_TICKS}
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            height={24}
            tickFormatter={(tick: number) => `${tick}%`}
            tick={{ fontSize: 10 }}
          />
          <ChartTooltip
            cursor={false}
            content={
              <ChartTooltipContent
                hideLabel
                formatter={(_value, _name, item) => {
                  const point = item.payload as CdfPoint;
                  return (
                    <div className="flex flex-1 items-center justify-between gap-3">
                      <span className="text-foreground font-mono font-medium tabular-nums">
                        ≤ {valueFormatter(point.value)}
                      </span>
                      <span className="text-muted-foreground tabular-nums">
                        {Math.round(point.share)}% · {formatCount(point.count)}
                      </span>
                    </div>
                  );
                }}
              />
            }
          />
          {/* `stepBefore` rises at the segment's left edge, so every x under a step reads as the
              bucket's upper bound — "this share stays ≤ this value" holds along the whole tread. */}
          <Area
            dataKey="value"
            type="stepBefore"
            stroke="var(--color-value)"
            strokeWidth={2.4}
            fill="var(--color-value)"
            fillOpacity={0.08}
            dot={false}
            activeDot={{ r: 3.5 }}
          />
          {markers.map((marker) => (
            <ReferenceDot
              key={marker.key}
              x={marker.share}
              y={marker.value}
              r={3.5}
              fill="var(--color-value)"
              stroke="var(--background)"
              strokeWidth={1.5}
              label={{
                value: marker.label,
                position: marker.share > EDGE_MARKER_SHARE ? 'left' : 'top',
                dy: -7,
                className: 'fill-secondary-foreground text-[0.625rem] font-semibold',
              }}
            />
          ))}
        </ComposedChart>
      </ChartContainer>
    </div>
  );
}

export { CdfChart };
