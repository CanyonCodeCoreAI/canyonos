import { DollarSignIcon } from 'lucide-react';

import { CardHeading } from '@repo/ui/components/card-heading';
import { TimeseriesChart } from '@repo/ui/components/charts/timeseries-chart';
import { Badge } from '@repo/ui/shadcn/badge';
import { Card } from '@repo/ui/shadcn/card';
import { cn } from '@repo/ui/utils';
import type { ChartConfig } from '@repo/ui/shadcn/chart';
import { formatMoney } from '@/modules/resources/resources.selectors';
import type { CostChartModel } from '@/modules/resources/resources.selectors';

const COST_CONFIG: ChartConfig = { value: { label: 'Cost', color: 'var(--chart-1)' } };

interface CPUCostCardProps {
  title: string;
  model: CostChartModel;
}

export function CPUCostCard({ title, model }: CPUCostCardProps) {
  return (
    <Card className="gap-4 rounded-2xl p-5" data-testid="cpu-cost-card">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-2">
          <CardHeading icon={DollarSignIcon}>{title}</CardHeading>
          <div className="flex items-center gap-2.5">
            <span className="text-foreground text-3xl leading-none font-bold tracking-tight tabular-nums">
              {model.totalLabel}
            </span>
            <Badge
              variant="outline"
              className={cn(
                'border-transparent',
                model.deltaUp ? 'text-heat-1 bg-heat-1/15' : 'text-heat-6 bg-heat-6/15'
              )}
            >
              {model.deltaLabel}
            </Badge>
          </div>
        </div>
        <span className="text-muted-foreground border-border bg-muted shrink-0 rounded-lg border px-2.5 py-1 font-mono text-[0.6875rem]">
          cumulative
        </span>
      </div>

      <div className="h-37 w-full">
        <TimeseriesChart
          data={model.points}
          config={COST_CONFIG}
          maxValue={model.maxValue}
          axisFormatter={formatMoney}
          valueFormatter={formatMoney}
        />
      </div>
    </Card>
  );
}
