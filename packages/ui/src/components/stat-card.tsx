import { cva } from 'class-variance-authority';
import type { VariantProps } from 'class-variance-authority';
import type { ComponentProps, ReactNode } from 'react';

import { cn } from '../lib/utils';
import { Card } from '../shadcn/card';

const statCardVariants = cva('flex flex-col', {
  variants: {
    tone: {
      default: '',
      warning: 'border-chart-3/35 bg-chart-3/8',
      danger: 'border-destructive/30 bg-destructive/6',
    },
    /**
     * `hero` is the headline tile of a screen. `compact` is the footnote form used inside another
     * card's footer, where the tile is one fact among several rather than the thing being read.
     */
    size: {
      hero: 'gap-2 px-[1.0625rem] py-[0.9375rem]',
      compact: 'bg-muted/40 gap-1.5 rounded-xl px-3.5 py-3',
    },
  },
  defaultVariants: { tone: 'default', size: 'hero' },
});

const statValueVariants = cva('leading-none font-bold tabular-nums', {
  variants: {
    tone: {
      default: 'text-foreground',
      warning: 'text-chart-3',
      danger: 'text-destructive',
    },
    size: {
      hero: 'text-[1.5rem] tracking-[-0.02em]',
      compact: 'shrink-0 font-mono text-[0.875rem] font-semibold',
    },
  },
  defaultVariants: { tone: 'default', size: 'hero' },
});

interface StatCardProps
  extends Omit<ComponentProps<typeof Card>, 'children' | 'title'>,
    VariantProps<typeof statCardVariants> {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  leading?: ReactNode;
}

export function StatCard({
  className,
  label,
  value,
  hint,
  leading,
  tone,
  size,
  ...props
}: StatCardProps) {
  // A compact tile keeps value and hint on one line so a row of them shares a height whatever the
  // hint says; an overlong hint ellipsizes rather than reflowing its neighbours.
  const inline = size === 'compact';

  return (
    <Card className={cn(statCardVariants({ tone, size }), className)} {...props}>
      <div className="flex min-w-0 items-center gap-2">
        {leading}
        <span className="text-muted-foreground truncate text-[0.65625rem] font-semibold tracking-[0.06em] uppercase">
          {label}
        </span>
      </div>
      {inline ? (
        <span className="flex min-w-0 items-baseline gap-x-2">
          <span className={statValueVariants({ tone, size })}>{value}</span>
          {hint ? (
            <span className="text-muted-foreground min-w-0 truncate text-[0.6875rem]">{hint}</span>
          ) : null}
        </span>
      ) : (
        <>
          <span className={statValueVariants({ tone, size })}>{value}</span>
          {hint ? (
            <span className="text-muted-foreground text-[0.71875rem] font-medium">{hint}</span>
          ) : null}
        </>
      )}
    </Card>
  );
}

export type { StatCardProps };
