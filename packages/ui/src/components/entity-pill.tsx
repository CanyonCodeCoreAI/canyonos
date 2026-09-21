import type { LucideIcon } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';

import { cn } from '../lib/utils';

type SegmentEmphasis = 'strong' | 'default' | 'muted';

export interface EntityPillSegment {
  readonly label: ReactNode;
  readonly emphasis?: SegmentEmphasis;
  readonly icon?: LucideIcon;
  readonly mono?: boolean;
}

interface EntityPillProps extends Omit<ComponentProps<'span'>, 'children'> {
  segments: readonly EntityPillSegment[];
}

const EMPHASIS_CLASS: Record<SegmentEmphasis, string> = {
  strong: 'bg-muted text-foreground font-bold',
  default: 'text-secondary-foreground font-semibold',
  muted: 'text-muted-foreground font-medium',
};

export function EntityPill({ segments, className, ...props }: EntityPillProps) {
  return (
    <span
      className={cn(
        'border-border bg-card inline-flex w-max items-stretch overflow-hidden rounded-full border shadow-xs',
        className
      )}
      {...props}
    >
      {segments.map((segment, index) => {
        const emphasis = segment.emphasis ?? 'default';
        const Icon = segment.icon;
        return (
          <span
            key={index}
            className={cn(
              'inline-flex items-center gap-1.5 py-1.5 text-sm whitespace-nowrap',
              emphasis === 'strong' ? 'px-3.5' : 'px-4',
              index > 0 && 'border-border border-l',
              segment.mono && 'font-mono',
              EMPHASIS_CLASS[emphasis]
            )}
          >
            {Icon ? (
              <Icon
                className="text-muted-foreground size-3 shrink-0"
                strokeWidth={1.8}
                aria-hidden
              />
            ) : null}
            {segment.label}
          </span>
        );
      })}
    </span>
  );
}
