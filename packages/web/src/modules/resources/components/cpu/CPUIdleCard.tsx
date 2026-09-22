import { BarChart3Icon } from 'lucide-react';

import { CardHeading } from '@repo/ui/components/card-heading';
import { BarChart } from '@repo/ui/components/charts/bar-chart';
import { Card } from '@repo/ui/shadcn/card';
import type { IdleChartModel } from '@/modules/resources/resources.selectors';

interface CPUIdleCardProps {
  title: string;
  model: IdleChartModel;
}

const formatMinutes = (value: number) => `${value}m`;

export function CPUIdleCard({ title, model }: CPUIdleCardProps) {
  return (
    <Card className="gap-4 rounded-2xl p-5" data-testid="cpu-idle-card">
      <div className="flex flex-col gap-2">
        <CardHeading icon={BarChart3Icon}>{title}</CardHeading>
        <span className="text-foreground text-3xl leading-none font-bold tracking-tight tabular-nums">
          {model.totalLabel}
          <span className="text-muted-foreground ml-1.5 text-sm font-semibold">min idle</span>
        </span>
      </div>

      <div className="h-56 w-full">
        <BarChart
          data={model.bars}
          config={model.config}
          axisFormatter={formatMinutes}
          valueFormatter={(value) => value.toLocaleString()}
        />
      </div>
    </Card>
  );
}
