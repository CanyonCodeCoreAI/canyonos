import type { ComponentProps } from 'react';

import { cn } from '../lib/utils';

interface MeterProps extends Omit<ComponentProps<'div'>, 'children'> {
  /** Filled portion, 0–100. Clamped so a rounding overshoot never spills past the track. */
  readonly value: number;
  readonly color: string;
  /** Accessible name for the bar, e.g. `Share of spend for retriever`. */
  readonly label: string;
  /** Spoken value, when the raw percentage is less useful than the formatted one. */
  readonly valueText?: string;
}

/**
 * The one share-bar surface: a track with a coloured fill, sized by its consumer. Used by the
 * ranked usage rows and by the cost blocks on the flow board.
 */
export function Meter({ value, color, label, valueText, className, ...props }: MeterProps) {
  const filled = Math.min(100, Math.max(0, value));

  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(filled)}
      aria-valuetext={valueText}
      className={cn('bg-border/60 relative h-1.5 overflow-hidden rounded-full', className)}
      {...props}
    >
      <span
        className="absolute inset-y-0 left-0 rounded-full"
        style={{ width: `${filled}%`, backgroundColor: color }}
      />
    </div>
  );
}
