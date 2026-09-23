import * as React from 'react';

import { cn } from '../lib/utils';

function Textarea({ className, ref, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      ref={ref}
      data-slot="textarea"
      className={cn(
        'border-input text-foreground focus-visible:ring-ring flex min-h-24 w-full rounded-md border bg-transparent px-3.5 py-3 text-sm transition-[color,box-shadow,border-color] focus-visible:ring-[3px] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50',
        'aria-[invalid=true]:border-destructive aria-[invalid=true]:ring-destructive/30 aria-[invalid=true]:ring-[3px]',
        className
      )}
      {...props}
    />
  );
}

export { Textarea };
