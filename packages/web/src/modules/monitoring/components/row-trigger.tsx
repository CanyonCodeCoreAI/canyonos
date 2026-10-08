import type { ComponentProps } from 'react';

import { CollapsibleTrigger } from '@repo/ui/shadcn/collapsible';
import { cn } from '@repo/ui/utils';

// Stretches over the nearest `relative` row, so a click anywhere on it toggles while keyboard and
// screen readers still get a native button.
export function RowTrigger({ className, ...props }: ComponentProps<typeof CollapsibleTrigger>) {
  return (
    <CollapsibleTrigger
      className={cn(
        'block w-full cursor-pointer truncate text-left after:absolute after:inset-0 after:z-10 focus-visible:outline-none',
        className
      )}
      {...props}
    />
  );
}
