import { ChevronLeft } from 'lucide-react';
import type { ComponentProps } from 'react';

import { cn } from '../lib/utils';

function BackButton({ className, children, ...props }: ComponentProps<'button'>) {
  return (
    <button
      type="button"
      className={cn(
        'text-muted-foreground hover:text-brand-deep inline-flex items-center gap-1.5 text-sm font-medium transition-colors',
        className
      )}
      {...props}
    >
      <ChevronLeft className="size-4" />
      {children ?? 'Back'}
    </button>
  );
}

export { BackButton };
