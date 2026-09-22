import { ZapIcon } from 'lucide-react';

import { CardHeading } from '@repo/ui/components/card-heading';
import { UsageProgressCard } from '@repo/ui/components/usage-progress-card';
import { Card } from '@repo/ui/shadcn/card';
import type { TopWorkflowItem } from '@/modules/resources/resources.selectors';

interface TopWorkflowsCardProps {
  title: string;
  items: readonly TopWorkflowItem[];
}

export function TopWorkflowsCard({ title, items }: TopWorkflowsCardProps) {
  return (
    <Card className="gap-0 rounded-2xl py-5" data-testid="top-workflows-card">
      <div className="flex items-center justify-between gap-2 px-5 pb-3.5">
        <CardHeading icon={ZapIcon}>{title}</CardHeading>
        <span className="text-muted-foreground font-mono text-[0.625rem]">alloc · util · cost</span>
      </div>

      <ul>
        {items.map((item) => (
          <li key={item.id} className="border-border/60 border-t px-5 py-3">
            <UsageProgressCard
              rank={item.rank}
              color={item.color}
              name={item.name}
              value={item.costLabel}
              progress={item.barPct}
            >
              <div className="flex items-center gap-2.5 font-mono text-[0.6875rem]">
                <span className="text-muted-foreground">{item.allocationLabel}</span>
                <span className="bg-placeholder size-[3px] rounded-full" aria-hidden />
                <span style={{ color: item.utilizationColor }}>{item.utilizationLabel}</span>
              </div>
            </UsageProgressCard>
          </li>
        ))}
      </ul>
    </Card>
  );
}
