import * as React from 'react';
import { Area, Bar, CartesianGrid, ComposedChart, XAxis, YAxis } from 'recharts';

import { cn } from '../../lib/utils';
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '../../shadcn/chart';
import type { ChartConfig } from '../../shadcn/chart';

// A point carries one number per series plus its x position, so `series` selects which keys are
// drawn. Single-series callers keep passing `{ index, value }`.
export interface SeriesPoint {
  readonly index: number;
  readonly [dataKey: string]: number;
}

const SINGLE_SERIES = ['value'] as const;

/** Keeps a bucket from reading as a slab of colour on a window that holds only a few of them. */
const MAX_BAR_WIDTH = 44;

const BAR_TOP_RADIUS: [number, number, number, number] = [4, 4, 0, 0];

/**
 * recharts crops a tick to the axis band rather than growing it, and callers format their own
 * values, so this is sized for the widest tick the money formatters produce — "$462.50" and the
 * sub-cent "$0.000123" both run past the 40px that used to cut the leading "$" off.
 */
const Y_AXIS_WIDTH = 56;

/**
 * Every bar is a bucket that was measured, so each one is labelled rather than thinned down to a
 * few anchors. Tilting is what lets ~30 of them sit side by side: laid on a diagonal, neighbours
 * only have to clear each other's line height instead of their full width, so a label costs about
 * the same sliver of axis whether it reads "Jul 23" or "Jul 1 – Jul 4".
 */
const BAR_TICK_ANGLE = -45;

/**
 * Room under the axis line for a tilted label to fall into. A 45° label drops by roughly 0.7× its
 * own width, so this is sized for the longest one a bucket axis carries — a two-date range.
 */
const BAR_AXIS_HEIGHT = 80;

export interface TimeseriesChartProps extends Omit<React.ComponentProps<'div'>, 'children'> {
  readonly data: readonly SeriesPoint[];
  readonly config: ChartConfig;
  readonly maxValue: number;
  /** Data keys to draw, bottom series first. More than one key stacks them. */
  readonly series?: readonly string[];
  /**
   * `area` reads as one continuous movement, at the cost of interpolating between two points.
   * `bar` keeps every bucket a separate column, so nothing is drawn that was not measured.
   */
  readonly mark?: 'area' | 'bar';
  readonly axisFormatter?: (value: number) => string;
  readonly valueFormatter?: (value: number) => string;
  /** Renders x-axis ticks. Receives the point's `index`; omit to keep the axis hidden. */
  readonly xTickFormatter?: (index: number) => string;
  /** Tooltip heading for the hovered point. Omit to leave the tooltip unlabelled. */
  readonly labelFormatter?: (point: SeriesPoint) => string;
}

function TimeseriesChart({
  data,
  config,
  maxValue,
  series = SINGLE_SERIES,
  mark = 'area',
  axisFormatter,
  valueFormatter,
  xTickFormatter,
  labelFormatter,
  className,
  ...props
}: TimeseriesChartProps) {
  const gradientId = React.useId().replace(/:/g, '');
  const formatValue = valueFormatter ?? ((value: number) => value.toLocaleString());
  const stacked = series.length > 1;
  const bars = mark === 'bar';

  return (
    <ChartContainer config={config} className={cn('aspect-auto size-full', className)} {...props}>
      <ComposedChart data={data as SeriesPoint[]} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
        {bars ? null : (
          <defs>
            {series.map((dataKey) => (
              <linearGradient
                key={dataKey}
                id={`${gradientId}-${dataKey}`}
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop
                  offset="0%"
                  stopColor={`var(--color-${dataKey})`}
                  stopOpacity={stacked ? 0.55 : 0.32}
                />
                <stop
                  offset="100%"
                  stopColor={`var(--color-${dataKey})`}
                  stopOpacity={stacked ? 0.16 : 0.02}
                />
              </linearGradient>
            ))}
          </defs>
        )}
        <CartesianGrid vertical={false} strokeDasharray="5 5" />
        <YAxis
          domain={[0, maxValue]}
          tickLine={false}
          axisLine={false}
          width={bars ? Y_AXIS_WIDTH : 40}
          tickMargin={bars ? 6 : undefined}
          tickCount={4}
          tickFormatter={axisFormatter}
          tick={{ fontSize: 10 }}
        />
        {xTickFormatter ? (
          <XAxis
            dataKey="index"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            // A numeric interval draws every tick and ignores `minTickGap`; an area interpolates
            // between its points, so it keeps dropping labels that would crowd their neighbours.
            interval={bars ? 0 : 'preserveEnd'}
            minTickGap={28}
            angle={bars ? BAR_TICK_ANGLE : 0}
            textAnchor={bars ? 'end' : 'middle'}
            height={bars ? BAR_AXIS_HEIGHT : 24}
            tickFormatter={(value) => xTickFormatter(Number(value))}
            tick={{ fontSize: 10 }}
          />
        ) : (
          <XAxis dataKey="index" hide />
        )}
        <ChartTooltip
          // Bars carry no active dot to mark the point being read, so the hovered column is banded
          // instead. An area traces its own value and needs neither.
          cursor={bars ? { fill: 'var(--foreground)', fillOpacity: 0.06 } : false}
          content={
            <ChartTooltipContent
              hideLabel={!labelFormatter}
              labelFormatter={
                labelFormatter
                  ? (_label, payload) => labelFormatter(payload[0]?.payload as SeriesPoint)
                  : undefined
              }
              formatter={(value, name) =>
                stacked ? (
                  <div className="flex flex-1 items-center justify-between gap-3">
                    <span className="text-muted-foreground">
                      {config[String(name)]?.label ?? name}
                    </span>
                    <span className="text-foreground font-mono font-medium tabular-nums">
                      {formatValue(Number(value))}
                    </span>
                  </div>
                ) : (
                  <span className="text-foreground font-mono font-medium tabular-nums">
                    {formatValue(Number(value))}
                  </span>
                )
              }
            />
          }
        />
        {series.map((dataKey, index) =>
          bars ? (
            <Bar
              key={dataKey}
              dataKey={dataKey}
              stackId={stacked ? 'total' : undefined}
              fill={`var(--color-${dataKey})`}
              maxBarSize={MAX_BAR_WIDTH}
              // Series stack bottom-first, so only the last one caps the column — rounding
              // every segment would notch the seam where two of them meet.
              radius={index === series.length - 1 ? BAR_TOP_RADIUS : 0}
            />
          ) : (
            <Area
              key={dataKey}
              dataKey={dataKey}
              type="monotone"
              stackId={stacked ? 'total' : undefined}
              stroke={`var(--color-${dataKey})`}
              strokeWidth={2.4}
              fill={`url(#${gradientId}-${dataKey})`}
              // recharts defaults Area fill to 0.6 opacity, which would dim the gradient stops
              // that already encode the intended fade.
              fillOpacity={1}
              dot={false}
              activeDot={{ r: 3.5 }}
            />
          )
        )}
      </ComposedChart>
    </ChartContainer>
  );
}

export { TimeseriesChart };
