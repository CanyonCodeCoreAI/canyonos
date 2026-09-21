import { ArrowRightIcon, CirclePlusIcon, XIcon } from 'lucide-react';
import type { ComponentProps, CSSProperties } from 'react';

import { Button } from '@repo/ui/shadcn/button';
import { Progress } from '@repo/ui/shadcn/progress';
import { cn } from '@repo/ui/utils';
import type { ProjectBreakdownModel } from '@/modules/resources/overview.selectors';

interface ProjectBreakdownPanelProps extends ComponentProps<'div'> {
  model: ProjectBreakdownModel | null;
  onClose: () => void;
}

export function ProjectBreakdownPanel({
  model,
  onClose,
  className,
  ...props
}: ProjectBreakdownPanelProps) {
  if (model == null) {
    return (
      <div
        data-testid="overview-breakdown-empty"
        className="border-border text-muted-foreground animate-in fade-in-0 ease-snappy flex items-center justify-center gap-2.5 rounded-xl border border-dashed p-4 text-sm duration-200"
      >
        <CirclePlusIcon className="size-4 shrink-0" aria-hidden />
        Select a project above to break down its consumption across every resource.
      </div>
    );
  }

  return (
    <div
      data-testid="overview-breakdown-panel"
      className={cn(
        'border-border bg-card animate-in fade-in-0 slide-in-from-bottom-1 ease-snappy grid grid-cols-1 overflow-hidden rounded-[1.125rem] border shadow-sm duration-200 md:grid-cols-[18.75rem_1fr]',
        className
      )}
      {...props}
    >
      <div
        className="border-border/60 flex flex-col gap-4 border-b p-5 md:border-r md:border-b-0"
        style={{ backgroundColor: model.tint }}
      >
        <div className="flex items-center justify-between gap-2.5">
          <section className="flex items-center gap-2.5">
            <span
              className="size-2.5 shrink-0 rounded-sm"
              style={{ backgroundColor: model.color }}
              aria-hidden
            />
            <span className="text-muted-foreground text-[0.625rem] font-bold tracking-[0.06em] uppercase">
              Project
            </span>
          </section>
          <button
            type="button"
            onClick={onClose}
            aria-label="Clear selected project"
            data-testid="overview-breakdown-close"
            className="text-muted-foreground hover:bg-accent hover:text-foreground ease-snappy focus-visible:ring-ring inline-flex size-6 items-center justify-center rounded-md transition-colors duration-150 focus-visible:ring-2 focus-visible:outline-none active:scale-95"
          >
            <XIcon className="size-3.5" aria-hidden />
          </button>
        </div>

        <h2 className="text-foreground text-[1.375rem] leading-tight font-bold tracking-tight">
          {model.projectName}
        </h2>

        <div className="grid grid-cols-2 gap-3">
          {model.stats.map((stat) => (
            <section key={stat.label} className="flex flex-col gap-0.5">
              <span className="text-foreground font-mono text-[1.0625rem] font-bold tracking-tight tabular-nums">
                {stat.value}
              </span>
              <span className="text-muted-foreground text-[0.625rem] font-semibold tracking-[0.04em] uppercase">
                {stat.label}
              </span>
            </section>
          ))}
        </div>

        <Button className="mt-0.5 w-full" data-testid="overview-view-project">
          View project
          <ArrowRightIcon className="size-3.5" aria-hidden />
        </Button>
      </div>

      <div className="flex flex-col gap-3 p-5">
        <span className="text-muted-foreground text-[0.625rem] font-bold tracking-[0.06em] uppercase">
          Share of each resource
        </span>
        {model.bars.map((bar) => (
          <div
            key={bar.resourceId}
            className="flex items-center gap-3"
            data-testid={`overview-bar-${bar.resourceId}`}
          >
            <span className="text-secondary-foreground w-[4.625rem] shrink-0 text-xs font-semibold">
              {bar.label}
            </span>
            <Progress
              value={bar.widthPct}
              aria-label={`${bar.label}: ${bar.pctLabel}`}
              className="h-2.5 flex-1"
              indicatorClassName="bg-[var(--bar-color)]"
              style={{ '--bar-color': bar.color } as CSSProperties}
            />
            <span className="text-foreground w-[2.875rem] shrink-0 text-right font-mono text-xs font-semibold tabular-nums">
              {bar.pctLabel}
            </span>
            <span className="text-muted-foreground w-[3.5rem] shrink-0 text-right font-mono text-xs tabular-nums">
              {bar.valueLabel}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
