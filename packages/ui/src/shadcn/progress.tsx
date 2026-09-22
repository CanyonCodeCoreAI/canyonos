import * as ProgressPrimitive from '@radix-ui/react-progress';
import type { ComponentProps } from 'react';

import { cn } from '../lib/utils';

type ProgressProps = ComponentProps<typeof ProgressPrimitive.Root> & {
  indicatorClassName?: string;
};

function Progress({ className, indicatorClassName, value, ...props }: ProgressProps) {
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      className={cn('bg-muted relative h-2 w-full overflow-hidden rounded-md', className)}
      value={value}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className={cn(
          'ease-snappy bg-primary h-full w-full flex-1 rounded-md transition-transform duration-500',
          indicatorClassName
        )}
        style={{ transform: `translateX(-${100 - (value ?? 0)}%)` }}
      />
    </ProgressPrimitive.Root>
  );
}

export { Progress };
