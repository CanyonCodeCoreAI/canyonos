import type { ComponentProps } from 'react';

import { cn } from '../lib/utils';

export interface LegendItem {
  readonly id: string;
  readonly label: string;
  readonly color: string;
}

interface LegendProps extends Omit<ComponentProps<'div'>, 'children'> {
  items: readonly LegendItem[];
}

export function Legend({ items, className, ...props }: LegendProps) {
  return (
    <div className={cn('flex flex-wrap items-center gap-3.5', className)} {...props}>
      {items.map((item) => (
        <span
          key={item.id}
          className="text-secondary-foreground inline-flex items-center gap-1.5 text-xs font-semibold"
        >
          <span
            className="size-2.25 shrink-0 rounded-sm"
            style={{ backgroundColor: item.color }}
            aria-hidden
          />
          {item.label}
        </span>
      ))}
    </div>
  );
}
