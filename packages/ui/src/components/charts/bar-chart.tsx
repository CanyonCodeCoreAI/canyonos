import * as React from 'react';
import {
  Bar,
  CartesianGrid,
  Cell,
  LabelList,
  BarChart as RechartsBarChart,
  ReferenceLine,
  XAxis,
  YAxis,
} from 'recharts';

import { cn } from '../../lib/utils';
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '../../shadcn/chart';
import type { ChartConfig } from '../../shadcn/chart';

export interface BarDatum {
  readonly key: string;
  readonly label: string;
  readonly value: number;
  readonly color?: string;
}

/** A dashed vertical line called out on the axis, e.g. a percentile over a histogram. */
export interface BarMarker {
  readonly key: string;
  /** The `BarDatum.label` the line sits on. Markers on an unknown category are not drawn. */
  readonly at: string;
  readonly label: string;
}

const NO_MARKERS: readonly BarMarker[] = [];

// Labels stack upward from the plot so two markers landing on the same bar stay readable.
const MARKER_LABEL_STEP = 12;

export interface BarChartProps extends React.ComponentProps<'div'> {
  readonly data: readonly BarDatum[];
  readonly config: ChartConfig;
  readonly valueFormatter?: (value: number) => string;
  readonly axisFormatter?: (value: number) => string;
  readonly showValueLabels?: boolean;
  /**
   * Ticks to skip between x labels, as recharts `interval`. A histogram with a bin per bar
   * wants a handful of readable edges, not every bin spelled out.
   */
  readonly xTickInterval?: number;
  /** Called with the clicked bar. Providing it makes the bars selectable. */
  readonly onBarSelect?: (datum: BarDatum) => void;
  /** `BarDatum.key` of the selected bar, drawn held-down against the others. */
  readonly selectedKey?: string;
  readonly xLabelAngle?: number;
  readonly markers?: readonly BarMarker[];
}

function BarChart({
  data,
  config,
  valueFormatter,
  axisFormatter,
  showValueLabels = true,
  xLabelAngle = -32,
  xTickInterval = 0,
  onBarSelect,
  selectedKey,
  markers = NO_MARKERS,
  className,
  ...props
}: BarChartProps) {
  const formatValue = valueFormatter ?? ((value: number) => value.toLocaleString());

  return (
    <ChartContainer config={config} className={cn('aspect-auto size-full', className)} {...props}>
      <RechartsBarChart
        data={data as BarDatum[]}
        margin={{ top: 20 + markers.length * MARKER_LABEL_STEP, right: 6, bottom: 6, left: 0 }}
      >
        <CartesianGrid vertical={false} strokeDasharray="4 4" />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={38}
          tickMargin={4}
          tickFormatter={axisFormatter}
          tick={{ fontSize: 10 }}
        />
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={false}
          interval={xTickInterval}
          height={56}
          angle={xLabelAngle}
          textAnchor="end"
          tickMargin={8}
          tick={{ fontSize: 11 }}
        />
        <ChartTooltip
          cursor={false}
          content={
            <ChartTooltipContent
              hideLabel
              formatter={(_value, _name, item) => {
                const datum = item.payload as BarDatum;
                return (
                  <div className="flex flex-1 items-center justify-between gap-3">
                    <span className="text-muted-foreground">{datum.label}</span>
                    <span className="text-foreground font-mono font-medium tabular-nums">
                      {formatValue(datum.value)}
                    </span>
                  </div>
                );
              }}
            />
          }
        />
        <Bar
          dataKey="value"
          radius={[5, 5, 0, 0]}
          maxBarSize={44}
          cursor={onBarSelect ? 'pointer' : undefined}
          onClick={onBarSelect ? (_payload, index) => onBarSelect(data[index]!) : undefined}
        >
          {showValueLabels ? (
            <LabelList
              dataKey="value"
              position="top"
              offset={8}
              className="fill-foreground text-[0.6875rem] font-semibold tabular-nums"
              formatter={formatValue}
            />
          ) : null}
          {data.map((datum) => (
            <Cell
              key={datum.key}
              fill={datum.color ?? `var(--color-${datum.key})`}
              // An unselected bar is dimmed rather than recoloured, so the series stays legible.
              fillOpacity={selectedKey === undefined || selectedKey === datum.key ? 1 : 0.3}
            />
          ))}
        </Bar>
        {markers.map((marker, index) => (
          <ReferenceLine
            key={marker.key}
            x={marker.at}
            stroke="var(--foreground)"
            strokeOpacity={0.45}
            strokeWidth={1.25}
            strokeDasharray="4 4"
            label={{
              value: marker.label,
              position: 'top',
              dy: -index * MARKER_LABEL_STEP,
              className: 'fill-secondary-foreground text-[0.625rem] font-semibold',
            }}
          />
        ))}
      </RechartsBarChart>
    </ChartContainer>
  );
}

export { BarChart };
