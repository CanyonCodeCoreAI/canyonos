import type { ComponentProps } from 'react';

import type { RequestStatus } from '@canyonos/api/core';

import { cn } from '../lib/utils';
import { STATUS_ACCENT, StatusDot } from './status-dot';

interface StatusPillProps extends Omit<ComponentProps<'span'>, 'children'> {
  status: RequestStatus;
  label: string;
}

export function StatusPill({ status, label, className, ...props }: StatusPillProps) {
  const accent = STATUS_ACCENT[status];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold',
        accent.soft,
        accent.text,
        className
      )}
      {...props}
    >
      <StatusDot status={status} decorative />
      {label}
    </span>
  );
}

export type { StatusPillProps };
