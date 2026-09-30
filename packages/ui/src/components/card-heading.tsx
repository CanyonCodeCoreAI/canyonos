import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '../lib/utils';

export interface CardHeadingProps {
  icon: LucideIcon;
  className?: string;
  children: ReactNode;
}

export function CardHeading({ icon: Icon, className, children }: CardHeadingProps) {
  return (
    <span
      className={cn(
        'text-secondary-foreground flex items-center gap-1.5 text-sm font-semibold',
        className
      )}
    >
      <Icon className="text-muted-foreground size-3.5" aria-hidden />
      {children}
    </span>
  );
}
