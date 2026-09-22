import { Card } from '@repo/ui/shadcn/card';
import { cn } from '@repo/ui/utils';
import type { KpiCardModel } from '@/modules/resources/overview.selectors';

const STAGGER = [
  '[animation-delay:0ms]',
  '[animation-delay:40ms]',
  '[animation-delay:80ms]',
  '[animation-delay:120ms]',
  '[animation-delay:160ms]',
  '[animation-delay:200ms]',
] as const;

interface ResourcesOverviewKpisContainerProps {
  kpis: readonly KpiCardModel[];
}

export function ResourcesOverviewKpisContainer({ kpis }: ResourcesOverviewKpisContainerProps) {
  return (
    <div
      className="grid [grid-template-columns:repeat(auto-fit,minmax(11rem,1fr))] gap-3.5"
      data-testid="overview-kpi-band"
    >
      {kpis.map((kpi, index) => (
        <Card
          key={kpi.id}
          className={cn(
            'animate-in fade-in-0 slide-in-from-bottom-1 fill-mode-both ease-snappy gap-2 rounded-2xl px-4.5 py-4 duration-300',
            STAGGER[index] ?? '[animation-delay:200ms]'
          )}
          data-testid={`overview-kpi-${kpi.id}`}
        >
          <span className="text-muted-foreground text-[0.625rem] font-semibold tracking-[0.06em] uppercase">
            {kpi.label}
          </span>
          <span className="text-foreground text-[1.6875rem] leading-none font-bold tracking-tight tabular-nums">
            {kpi.value}
          </span>
          <span className={`${kpi.subToneClass} text-xs font-medium`}>{kpi.subLabel}</span>
        </Card>
      ))}
    </div>
  );
}
