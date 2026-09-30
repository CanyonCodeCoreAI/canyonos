import * as React from 'react';

import { cn } from '../lib/utils';

function Input({ className, type, ref, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      ref={ref}
      className={cn(
        'border-input bg-background text-foreground file:text-foreground flex h-11 w-full rounded-md border px-3.5 py-3 text-sm transition-[color,box-shadow,border-color] file:border-0 file:bg-transparent file:text-sm file:font-medium focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50',
        'aria-[invalid=true]:border-destructive/60 aria-[invalid=true]:ring-destructive/15 aria-[invalid=true]:ring-[3px]',
        className
      )}
      {...props}
    />
  );
}

export { Input };
