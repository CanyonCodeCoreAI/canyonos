import * as React from 'react';

import { cn } from '../lib/utils';

function Label({ className, ref, ...props }: React.ComponentProps<'label'>) {
  return (
    <label
      ref={ref}
      className={cn(
        'text-secondary-foreground flex items-center gap-2 text-xs font-semibold select-none',
        'peer-disabled:cursor-not-allowed peer-disabled:opacity-70',
        className
      )}
      {...props}
    />
  );
}

export { Label };
