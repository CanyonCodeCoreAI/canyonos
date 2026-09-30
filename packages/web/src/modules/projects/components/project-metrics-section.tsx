import { useId } from 'react';
import type { ReactNode } from 'react';

import { cn } from '@repo/ui/utils';

interface ProjectMetricsSectionProps {
  /** Omit to render a headerless section — the body sits flush with no title row. */
  readonly title?: string;
  readonly test_id: string;
  /** One line saying what the section answers, under its heading. */
  readonly description?: string;
  /** Controls or legends that scope this section only, rendered beside its heading. */
  readonly action?: ReactNode;
  /**
   * Draws the whole section as one card — heading, body and footer inside a single border.
   * Use it when the parts only make sense read together, as with the flow board and its stats.
   */
  readonly framed?: boolean;
  /** Summary facts rendered below the body — inside the frame when the section is framed. */
  readonly footer?: ReactNode;
  readonly className?: string;
  readonly children: ReactNode;
}

export function ProjectMetricsSection({
  title,
  test_id,
  description,
  action,
  framed = false,
  footer,
  className,
  children,
}: ProjectMetricsSectionProps) {
  const heading_id = useId();
  const has_header = Boolean(title || description || action);

  return (
    <section
      className={cn(
        'flex flex-col gap-3',
        framed && 'border-border bg-card gap-4 rounded-2xl border p-5 shadow-xs',
        className
      )}
      aria-labelledby={title ? heading_id : undefined}
      data-testid={test_id}
    >
      {has_header ? (
        <div
          className={cn(
            'flex shrink-0 flex-wrap justify-between gap-x-6 gap-y-2',
            description ? 'items-start' : 'min-h-8 items-center'
          )}
        >
          <div className="flex min-w-0 flex-col gap-1">
            {title ? (
              <h2
                id={heading_id}
                className="text-foreground text-[1rem] leading-tight font-bold tracking-[-0.01em]"
              >
                {title}
              </h2>
            ) : null}
            {description ? (
              <p className="text-muted-foreground max-w-[38rem] text-[0.8125rem] leading-relaxed text-pretty">
                {description}
              </p>
            ) : null}
          </div>
          {action}
        </div>
      ) : null}
      {children}
      {footer ? <footer className="flex shrink-0 flex-col gap-3">{footer}</footer> : null}
    </section>
  );
}
