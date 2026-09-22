import type { ReactNode } from 'react';

import { cn } from '../lib/utils';
import { Meter } from './meter';

export interface UsageProgressCardProps {
  rank: number;
  color: string;
  name: string;
  value: string;
  progress: number;
  className?: string;
  children?: ReactNode;
}

export function UsageProgressCard({
  rank,
  color,
  name,
  value,
  progress,
  className,
  children,
}: UsageProgressCardProps) {
  return (
    <div className={cn('flex items-center gap-3.5', className)}>
      <span
        className="border-border flex size-7 shrink-0 items-center justify-center rounded-lg border font-mono text-xs font-bold tabular-nums"
        style={{ color, backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)` }}
      >
        {rank}
      </span>

      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-secondary-foreground min-w-0 truncate text-sm font-semibold">
            {name}
          </span>
          <span className="text-foreground shrink-0 font-mono text-xs font-bold tabular-nums">
            {value}
          </span>
        </div>

        <Meter value={progress} color={color} label={`${name} share`} valueText={value} />

        {children}
      </div>
    </div>
  );
}
