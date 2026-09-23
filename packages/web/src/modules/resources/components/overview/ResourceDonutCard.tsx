import { DonutChart } from '@repo/ui/components/charts/donut-chart';
import { Card } from '@repo/ui/shadcn/card';
import { cn } from '@repo/ui/utils';
import type { ResourceDonutModel } from '@/modules/resources/overview.selectors';

const STAGGER = [
  '[animation-delay:0ms]',
  '[animation-delay:40ms]',
  '[animation-delay:80ms]',
  '[animation-delay:120ms]',
  '[animation-delay:160ms]',
  '[animation-delay:200ms]',
] as const;

interface ResourceDonutCardProps {
  model: ResourceDonutModel;
  index: number;
  onSegmentSelect: (projectId: string) => void;
}

export function ResourceDonutCard({ model, index, onSegmentSelect }: ResourceDonutCardProps) {
  return (
    <Card
      className={cn(
        'animate-in fade-in-0 slide-in-from-bottom-1 fill-mode-both ease-snappy items-center gap-3 rounded-[1.125rem] px-4.5 pt-4.5 pb-4 duration-300',
        STAGGER[index] ?? '[animation-delay:200ms]'
      )}
      data-testid={`overview-donut-${model.id}`}
    >
      <div className="flex w-full items-center justify-between gap-2">
        <span className="flex items-center gap-2">
          <span
            className="size-2.5 shrink-0 rounded-sm"
            style={{ backgroundColor: model.color }}
            aria-hidden
          />
          <span className="text-secondary-foreground text-sm font-bold">{model.label}</span>
        </span>
        <span className="text-muted-foreground font-mono text-xs tabular-nums">
          {model.poolLabel}
        </span>
      </div>

      {model.empty ? (
        <div
          className="border-border text-muted-foreground flex size-[9.75rem] flex-col items-center justify-center gap-1 rounded-full border-2 border-dashed"
          role="img"
          aria-label={`${model.label} usage is not tracked yet`}
        >
          <span className="font-mono text-xl leading-none tabular-nums">{model.centerValue}</span>
          <span className="text-[0.625rem] font-semibold tracking-[0.04em] uppercase">
            {model.centerLabel}
          </span>
        </div>
      ) : (
        <DonutChart
          className="w-[9.75rem]"
          data={model.segments}
          config={model.config}
          centerValue={model.centerValue}
          centerLabel={model.centerLabel}
          activeKey={model.activeKey}
          inactiveOpacity={0.16}
          onSegmentSelect={onSegmentSelect}
          tooltipValueFormatter={(datum) => datum.value.toLocaleString()}
        />
      )}

      <div className="flex min-h-[1.125rem] w-full items-center justify-center gap-1.5">
        {model.empty ? null : (
          <span
            className="size-2 shrink-0 rounded-full"
            style={{ backgroundColor: model.captionColor }}
            aria-hidden
          />
        )}
        <span
          className="truncate text-xs font-semibold tabular-nums"
          style={{ color: model.captionColor }}
        >
          {model.captionText}
        </span>
      </div>
    </Card>
  );
}
