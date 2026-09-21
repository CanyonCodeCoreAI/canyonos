import { ChartPieIcon } from 'lucide-react';

import { CardHeading } from '@repo/ui/components/card-heading';
import { DonutChart } from '@repo/ui/components/charts/donut-chart';
import { Card } from '@repo/ui/shadcn/card';
import type { AllocationModel } from '@/modules/resources/resources.selectors';

interface CPUAllocationCardProps {
  model: AllocationModel;
}

export function CPUAllocationCard({ model }: CPUAllocationCardProps) {
  return (
    <Card className="gap-4 rounded-2xl p-5" data-testid="cpu-allocation-card">
      <CardHeading icon={ChartPieIcon}>Allocation by project</CardHeading>

      <div className="flex items-center gap-4">
        <DonutChart
          className="w-28 shrink-0"
          data={model.segments}
          config={model.config}
          centerValue={model.centerValue}
          centerLabel={model.centerLabel}
          tooltipValueFormatter={(datum) => datum.value.toLocaleString()}
        />

        <ul className="flex min-w-0 flex-1 flex-col gap-2.5">
          {model.legend.map((item) => (
            <li key={item.id} className="flex min-w-0 items-center gap-2 text-xs">
              <span
                className="size-2.5 shrink-0 rounded-sm"
                style={{ backgroundColor: item.color }}
                aria-hidden
              />
              <span className="text-secondary-foreground min-w-0 flex-1 truncate">{item.name}</span>
              <span className="text-foreground shrink-0 font-mono font-semibold tabular-nums">
                {item.valueLabel}
              </span>
              <span className="text-muted-foreground w-9 shrink-0 text-right font-mono tabular-nums">
                {item.pctLabel}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <p className="bg-accent/60 text-secondary-foreground border-primary/15 rounded-xl border p-3.5 text-xs leading-relaxed">
        {model.note}
      </p>
    </Card>
  );
}
