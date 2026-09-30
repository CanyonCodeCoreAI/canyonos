import * as React from 'react';
import { Cell, Pie, PieChart } from 'recharts';

import { cn } from '../../lib/utils';
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '../../shadcn/chart';
import type { ChartConfig } from '../../shadcn/chart';

export interface DonutDatum {
  readonly key: string;
  readonly value: number;
}

export interface DonutChartProps extends React.ComponentProps<'div'> {
  readonly data: readonly DonutDatum[];
  readonly config: ChartConfig;
  readonly centerValue?: React.ReactNode;
  readonly centerLabel?: React.ReactNode;
  readonly tooltipValueFormatter?: (datum: DonutDatum) => React.ReactNode;
  readonly innerRadius?: string;
  readonly paddingAngle?: number;
  readonly activeKey?: string | null;
  readonly onSegmentSelect?: (key: string) => void;
  readonly inactiveOpacity?: number;
}

function DonutChart({
  data,
  config,
  centerValue,
  centerLabel,
  tooltipValueFormatter,
  innerRadius = '66%',
  paddingAngle = 2.5,
  activeKey = null,
  onSegmentSelect,
  inactiveOpacity = 1,
  className,
  ...props
}: DonutChartProps) {
  const handlePieClick = onSegmentSelect
    ? (payload: { readonly payload?: DonutDatum }) => {
        const key = payload?.payload?.key;
        if (key != null) onSegmentSelect(key);
      }
    : undefined;
  return (
    <div className={cn('relative mx-auto aspect-square w-40', className)} {...props}>
      <ChartContainer config={config} className="aspect-square size-full">
        <PieChart>
          <ChartTooltip
            cursor={false}
            // recharts' tooltip wrapper defaults to z-index auto; lift it above the
            // absolutely-positioned center overlay below so hovering a segment isn't obscured.
            wrapperStyle={{ zIndex: 20 }}
            content={
              <ChartTooltipContent
                hideLabel
                formatter={(value, name) => {
                  const datum = data.find((d) => d.key === name);
                  const label = config[name as string]?.label ?? name;
                  return (
                    <div className="flex flex-1 items-center justify-between gap-3">
                      <span className="text-muted-foreground">{label}</span>
                      <span className="text-foreground font-mono font-medium tabular-nums">
                        {datum && tooltipValueFormatter
                          ? tooltipValueFormatter(datum)
                          : Number(value).toLocaleString()}
                      </span>
                    </div>
                  );
                }}
              />
            }
          />
          <Pie
            data={data as DonutDatum[]}
            dataKey="value"
            nameKey="key"
            innerRadius={innerRadius}
            outerRadius="100%"
            paddingAngle={paddingAngle}
            strokeWidth={0}
            onClick={handlePieClick}
          >
            {data.map((datum) => (
              <Cell
                key={datum.key}
                fill={`var(--color-${datum.key})`}
                fillOpacity={activeKey == null || activeKey === datum.key ? 1 : inactiveOpacity}
                className={onSegmentSelect ? 'cursor-pointer' : undefined}
              />
            ))}
          </Pie>
        </PieChart>
      </ChartContainer>
      {centerValue != null || centerLabel != null ? (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-0.5">
          {centerValue != null ? (
            <span className="text-foreground text-xl leading-none font-bold tracking-tight tabular-nums">
              {centerValue}
            </span>
          ) : null}
          {centerLabel != null ? (
            <span className="text-muted-foreground text-[0.625rem] font-semibold tracking-[0.05em] uppercase">
              {centerLabel}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export { DonutChart };
