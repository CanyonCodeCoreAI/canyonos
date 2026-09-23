import { ChevronDown } from 'lucide-react';
import * as React from 'react';

import { cn } from '../lib/utils';

function NativeSelect({ className, children, ref, ...props }: React.ComponentProps<'select'>) {
  return (
    <div className="relative">
      <select
        ref={ref}
        className={cn(
          'border-input bg-background text-foreground h-11 w-full appearance-none rounded-md border py-3 pr-10 pl-3.5 text-sm transition-[color,box-shadow,border-color] outline-none disabled:cursor-not-allowed disabled:opacity-50',
          'aria-[invalid=true]:border-destructive/60 aria-[invalid=true]:ring-destructive/15 aria-[invalid=true]:ring-[3px]',
          className
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown className="text-muted-foreground pointer-events-none absolute top-1/2 right-3.5 size-4 -translate-y-1/2" />
    </div>
  );
}

export { NativeSelect };
