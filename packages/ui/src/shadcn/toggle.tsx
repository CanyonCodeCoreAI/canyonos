import * as TogglePrimitive from '@radix-ui/react-toggle';
import { cva } from 'class-variance-authority';
import * as React from 'react';
import type { VariantProps } from 'class-variance-authority';

import { cn } from '../lib/utils';

const toggleVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-sm text-[13px] font-semibold text-muted-foreground transition-[color,background-color,box-shadow] ease-snappy duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=on]:bg-foreground/10 data-[state=on]:text-foreground data-[state=on]:shadow-sm [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-transparent',
        outline:
          'border border-input bg-transparent hover:bg-muted data-[state=on]:border-transparent',
      },
      size: {
        default: 'h-8 min-w-8 px-3.5',
        sm: 'h-7 min-w-7 px-2.5',
        lg: 'h-10 min-w-10 px-5',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  }
);

function Toggle({
  className,
  variant,
  size,
  ref,
  ...props
}: React.ComponentProps<typeof TogglePrimitive.Root> & VariantProps<typeof toggleVariants>) {
  return (
    <TogglePrimitive.Root
      ref={ref}
      data-slot="toggle"
      className={cn(toggleVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Toggle, toggleVariants };
